import {
    Injectable,
    NotFoundException,
    BadRequestException,
    ForbiddenException,
    Logger,
    InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { JobStatus } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class StaffService {
    private readonly logger = new Logger(StaffService.name);

    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService
    ) { }

    private async assertStaffAccess(userId: number) {
        const staffMember = await this.prisma.staff.findUnique({
            where: { userId },
            select: { id: true },
        });

        if (!staffMember) {
            throw new ForbiddenException('Only admin-assigned staff can access this dashboard');
        }
    }

    async getMyAssignedJobs(userId: number) {
        try {
            await this.assertStaffAccess(userId);
            this.logger.log(`Fetching jobs for staff user ${userId}`);

            const jobs = await this.prisma.job.findMany({
                where: {
                    assignments: {
                        some: {
                            applierId: userId,
                        },
                    },
                },
                include: {
                    owner: {
                        select: {
                            firstName: true,
                            lastName: true,
                            fullName: true,
                            avatar: true,
                        },
                    },
                    property: true,
                    hotel: true,
                },
                orderBy: {
                    createdAt: 'desc',
                },
            });

            return {
                success: true,
                data: jobs,
            };
        } catch (error) {
            this.logger.error(`Failed to fetch assigned jobs for user ${userId}`, error.stack);
            if (error instanceof ForbiddenException) {
                throw error;
            }
            throw new InternalServerErrorException('Failed to fetch assigned jobs');
        }
    }

    async acceptJob(jobId: number, userId: number) {
        try {
            await this.assertStaffAccess(userId);
            const job = await this.prisma.job.findUnique({
                where: { id: jobId },
                include: { assignments: true },
            });

            if (!job) throw new NotFoundException('Job not found');

            const assigned = job.assignments.some((a) => a.applierId === userId);
            if (!assigned) throw new ForbiddenException('You are not assigned to this job');

            if (job.status !== JobStatus.PENDING) {
                throw new BadRequestException(`Job is already in ${job.status} state`);
            }

            const updatedJob = await this.prisma.job.update({
                where: { id: jobId },
                data: { status: JobStatus.IN_PROGRESS },
            });

            const staff = await this.prisma.user.findUnique({ where: { id: userId } });
            const staffName = staff?.fullName || staff?.firstName || 'Staff';

            await this.notifications.createNotification({
                title: 'Job Accepted',
                message: `${staffName} has accepted the job "${job.title}".`,
                type: 'INFO',
                userId: job.ownerId,
                relatedId: job.id,
                relatedType: 'JOB',
            });

            return {
                success: true,
                message: 'Job accepted and started',
                data: updatedJob,
            };
        } catch (error) {
            this.logger.error(`Failed to accept job ${jobId} for user ${userId}`, error.stack);
            if (error instanceof NotFoundException || error instanceof ForbiddenException || error instanceof BadRequestException) {
                throw error;
            }
            throw new InternalServerErrorException('Failed to accept job');
        }
    }

    async submitJob(jobId: number, userId: number, beforeImage: string, afterImage: string) {
        try {
            await this.assertStaffAccess(userId);
            const job = await this.prisma.job.findUnique({
                where: { id: jobId },
                include: { assignments: true },
            });

            if (!job) throw new NotFoundException('Job not found');

            const assigned = job.assignments.some((a) => a.applierId === userId);
            if (!assigned) throw new ForbiddenException('You are not assigned to this job');

            if (job.status !== JobStatus.IN_PROGRESS && job.status !== JobStatus.REJECTED) {
                throw new BadRequestException(`Job cannot be submitted in ${job.status} state`);
            }

            const updatedJob = await this.prisma.job.update({
                where: { id: jobId },
                data: {
                    status: JobStatus.AWAITING_REVIEW,
                    beforeImage,
                    afterImage,
                    rejectionReason: null, // Clear reason on resubmit
                },
            });

            const staff = await this.prisma.user.findUnique({ where: { id: userId } });
            const staffName = staff?.fullName || staff?.firstName || 'Staff';

            await this.notifications.createNotification({
                title: 'Photos Submitted',
                message: `${staffName} submitted photos for "${job.title}". Job is awaiting review.`,
                type: 'SUCCESS',
                userId: job.ownerId,
                relatedId: job.id,
                relatedType: 'JOB',
            });

            return {
                success: true,
                message: 'Job submitted for review',
                data: updatedJob,
            };
        } catch (error) {
            this.logger.error(`Failed to submit job ${jobId} for user ${userId}`, error.stack);
            throw error;
        }
    }

    async rejectJob(jobId: number, userId: number) {
        try {
            await this.assertStaffAccess(userId);
            const job = await this.prisma.job.findUnique({
                where: { id: jobId },
                include: { assignments: true },
            });

            if (!job) throw new NotFoundException('Job not found');

            const assignment = job.assignments.find((a) => a.applierId === userId);
            if (!assignment) throw new ForbiddenException('You are not assigned to this job');

            // Rejection logic: Delete assignment and reset job status to QUEUED
            await this.prisma.$transaction([
                this.prisma.jobAssignment.delete({
                    where: { id: assignment.id },
                }),
                this.prisma.job.update({
                    where: { id: jobId },
                    data: { status: JobStatus.QUEUED },
                }),
            ]);

            const staff = await this.prisma.user.findUnique({ where: { id: userId } });
            const staffName = staff?.fullName || staff?.firstName || 'Staff';

            await this.notifications.createNotification({
                title: 'Job Rejected',
                message: `${staffName} has rejected the job "${job.title}". It is back in the queue.`,
                type: 'WARNING',
                userId: job.ownerId,
                relatedId: job.id,
                relatedType: 'JOB',
            });

            return {
                success: true,
                message: 'Job rejected and returned to queue',
            };
        } catch (error) {
            this.logger.error(`Failed to reject job ${jobId} for user ${userId}`, error.stack);
            if (error instanceof NotFoundException || error instanceof ForbiddenException) {
                throw error;
            }
            throw new InternalServerErrorException('Failed to reject job');
        }
    }

    async getMyEarnings(userId: number) {
        try {
            await this.assertStaffAccess(userId);
            const completedJobs = await this.prisma.job.findMany({
                where: {
                    assignments: {
                        some: { applierId: userId },
                    },
                    status: { in: [JobStatus.COMPLETED, JobStatus.APPROVED] },
                },
                select: {
                    budget: true,
                    title: true,
                    id: true,
                    updatedAt: true,
                },
            });

            const totalEarnings = completedJobs.reduce((sum, job) => sum + (job.budget ?? 0), 0);

            return {
                success: true,
                data: {
                    totalEarnings,
                    jobsCount: completedJobs.length,
                    completedJobs,
                },
            };
        } catch (error) {
            this.logger.error(`Failed to calculate earnings for user ${userId}`, error.stack);
            if (error instanceof ForbiddenException) {
                throw error;
            }
            throw new InternalServerErrorException('Failed to calculate earnings');
        }
    }
}
