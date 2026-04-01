import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePropertyDto } from './dto/create-property.dto';
import { UpdatePropertyDto } from './dto/update-property.dto';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';
import { BookingStatus, Currency, ListingType, PropertyType, Room } from '@prisma/client';
import { CreateHotelBookingDto } from './dto/create-hotel-booking.dto';

@Injectable()
export class ListingService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnerListingSummary(uId: number) {
    const properties = await this.prisma.property.count({
      where: { ownerId: uId },
    });
    const hotels = await this.prisma.hotel.count({
      where: { ownerId: uId },
    });
    const bookings = await this.prisma.booking.count({
      where: {
        OR: [{ hotel: { ownerId: uId } }, { property: { ownerId: uId } }],
      },
    });

    // Calculate total revenue from completed bookings
    const completedBookings = await this.prisma.booking.findMany({
      where: {
        OR: [{ hotel: { ownerId: uId } }, { property: { ownerId: uId } }],
        status: BookingStatus.COMPLETED,
      },
      select: { totalPrice: true },
    });

    const totalRevenue = completedBookings.reduce(
      (sum, b) => sum + Number(b.totalPrice),
      0,
    );

    return {
      properties,
      hotels,
      bookings,
      totalRevenue,
    };
  }

  // ─── Properties ────────────────────────────────────────

  async createProperty(dto: CreatePropertyDto, uId: number) {
    return this.prisma.property.create({
      data: {
        ...dto,
        owner: {
          connect: { id: uId },
        },
      },
    });
  }

  async getAllProperties() {
    return this.prisma.property.findMany({
      include: {
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                fullName: true,
                avatar: true,
              },
            },
          },
        },
        owner: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            fullName: true,
            email: true,
            avatar: true,
          }
        }
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMyProperties(uId: number) {
    return this.prisma.property.findMany({
      where: { ownerId: uId },
      include: {
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                fullName: true,
                avatar: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPropertyById(id: number) {
    const property = await this.prisma.property.findUnique({
      where: { id },
      include: {
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                fullName: true,
                avatar: true,
              },
            },
          },
        },
        owner: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            fullName: true,
            email: true,
            avatar: true,
          }
        }
      },
    });
    if (!property) {
      throw new NotFoundException('Property not found');
    }
    return property;
  }

  async updateProperty(id: number, data: UpdatePropertyDto | { isActive: boolean }, uId: number) {
    const property = await this.prisma.property.findUnique({ where: { id } });
    if (!property) {
      throw new NotFoundException('Property not found');
    }
    if (property.ownerId !== uId) {
      throw new ForbiddenException('You do not own this property');
    }

    return this.prisma.property.update({
      where: { id },
      data,
    });
  }

  async deleteProperty(id: number, uId: number) {
    const property = await this.prisma.property.findUnique({ where: { id } });
    if (!property) {
      throw new NotFoundException('Property not found');
    }
    if (property.ownerId !== uId) {
      throw new ForbiddenException('You do not own this property');
    }

    await this.prisma.property.delete({ where: { id } });
    return { success: true, message: 'Property deleted successfully' };
  }

  // ─── Hotels ────────────────────────────────────────────
  async createHotel(data: CreateHotelDto, uId: number, rooms: { title: string; price: number; image?: string }[] = []) {
    try {
      const hotel = await this.prisma.hotel.create({
        data: {
          ...data,
          owner: {
            connect: { id: uId },
          },
          rooms: rooms.length > 0
            ? {
              create: rooms.map((r) => ({
                title: r.title || 'Room',
                price: r.price || 0,
                image: r.image || null,
              } as any)),
            }
            : undefined,
        },
        include: { rooms: true },
      });

      return { success: true, message: 'Hotel created successfully', hotel };
    } catch (error) {
      throw new InternalServerErrorException(error?.message);
    }
  }

  async getAllHotels() {
    return this.prisma.hotel.findMany({
      include: {
        rooms: true,
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                fullName: true,
                avatar: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMyHotels(uId: number) {
    return this.prisma.hotel.findMany({
      where: { ownerId: uId },
      include: {
        rooms: true,
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                fullName: true,
                avatar: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getHotelById(id: number) {
    const hotel = await this.prisma.hotel.findUnique({
      where: { id },
      include: {
        rooms: true,
        reviews: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                fullName: true,
                avatar: true,
              },
            },
          },
        },
      },
    });
    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }
    return hotel;
  }

  async updateHotel(id: number, data: UpdateHotelDto | { isActive: boolean }, uId: number, rooms: { id?: number; title: string; price: number; image?: string }[] = []) {
    const hotel = await this.prisma.hotel.findUnique({
      where: { id },
      include: { rooms: true }
    });
    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }
    if (hotel.ownerId !== uId) {
      throw new ForbiddenException('You do not own this hotel');
    }

    // Smart sync for rooms
    const existingRoomIds = hotel.rooms.map(r => r.id);
    const updatedRoomIds = rooms.map(r => r.id).filter(id => id !== undefined);
    const roomsToDelete = existingRoomIds.filter(id => !updatedRoomIds.includes(id));

    // Perform updates in a transaction or sequence
    await this.prisma.$transaction(async (tx) => {
      // 1. Delete rooms that are no longer in the list
      if (roomsToDelete.length > 0) {
        await tx.room.deleteMany({
          where: { id: { in: roomsToDelete } },
        });
      }

      // 2. Create or Update remaining rooms
      for (const roomData of rooms) {
        if (roomData.id) {
          // Update existing
          const existingRoom = hotel.rooms.find(r => r.id === roomData.id);
          await tx.room.update({
            where: { id: roomData.id },
            data: {
              title: roomData.title,
              price: roomData.price,
              image: roomData.image || (existingRoom as any)?.image,
            } as any,
          });
        } else {
          // Create new
          await tx.room.create({
            data: {
              title: roomData.title,
              price: roomData.price,
              image: roomData.image || null,
              hotel: { connect: { id } },
            } as any,
          });
        }
      }
    });

    return this.prisma.hotel.update({
      where: { id },
      data: data as any,
      include: { rooms: true }
    });
  }

  async deleteHotel(id: number, uId: number) {
    const hotel = await this.prisma.hotel.findUnique({ where: { id } });
    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }
    if (hotel.ownerId !== uId) {
      throw new ForbiddenException('You do not own this hotel');
    }

    await this.prisma.hotel.delete({ where: { id } });
    return { success: true, message: 'Hotel deleted successfully' };
  }

  async getRoomById(id: number) {
    return this.prisma.room.findUnique({ where: { id } });
  }

  // ─── AI Analysis ─────────────────────────────────────────

  async analyzeProperty(id: number) {
    const property = await this.prisma.property.findUnique({
      where: { id },
    });
    if (!property) throw new NotFoundException('Property not found');

    // Currently returns mock insights
    // In a real app, this would call GPT or similar for analysis
    return {
      id: property.id,
      insights: [
        {
          label: 'High Rental Yield',
          value: '8.5%',
          trend: 'up',
          description: 'Based on current area trends',
        },
        {
          label: 'Area Demand',
          value: 'High',
          trend: 'up',
          description: 'Increasing interest in this neighborhood',
        },
        {
          label: 'Price per SqFt',
          value: `$${(Number(property.price) / (property.area || 1000)).toFixed(2)}`,
          trend: 'stable',
          description: 'Competitive for recently sold properties',
        },
      ],
      prediction: {
        nextYear: '+12%',
        confidence: '85%',
      },
    };
  }

  // ─── Bookings ────────────────────────────────────────────

  async createHotelBooking(dto: CreateHotelBookingDto, userId: number) {
    const { hotelId, checkIn, checkOut, rooms } = dto;

    const hotel = await this.prisma.hotel.findUnique({
      where: { id: hotelId },
      include: { rooms: true },
    });

    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }

    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const nights = Math.ceil(
      (checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (nights <= 0) {
      throw new BadRequestException('Check-out must be after check-in');
    }

    // Calculate total price and prepare room creation data
    let totalPrice = 0;
    let totalRooms = 0;
    const roomById = new Map(hotel.rooms.map((r) => [r.id, r]));
    const selectedRoomIds = rooms.map((r) => r.roomId);
    const roomQuantityMap = new Map(rooms.map((r) => [r.roomId, r.quantity]));

    const bookingData: {
      userId: number;
      hotelId: number;
      roomId: number;
      checkIn: Date;
      checkOut: Date;
      totalPrice: number;
      status: BookingStatus;
    }[] = [];

    for (const roomId of selectedRoomIds) {
      const room = roomById.get(roomId) as Room;
      const quantity = roomQuantityMap.get(roomId)!;
      const roomTotal = Number(room.price) * nights;

      totalPrice += roomTotal * quantity;
      totalRooms += quantity;

      for (let i = 0; i < quantity; i++) {
        bookingData.push({
          userId,
          hotelId: hotel.id,
          roomId,
          checkIn: checkInDate,
          checkOut: checkOutDate,
          totalPrice: roomTotal,
          status: BookingStatus.PENDING,
        });
      }
    }

    const bookings = await this.prisma.$transaction(
      bookingData.map((payload) =>
        this.prisma.booking.create({
          data: payload,
          include: {
            room: { select: { id: true, title: true, price: true } },
          },
        }),
      ),
    );

    return {
      success: true,
      message: 'Booking request sent',
      totalPrice,
      totalRooms,
      bookings,
    };
  }

  async getUserBookings(userId: number) {
    const bookings = await this.prisma.booking.findMany({
      where: { userId },
      include: {
        hotel: { select: { id: true, title: true, address: true, images: true } },
        property: {
          select: { id: true, title: true, address: true, images: true },
        },
        room: { select: { id: true, title: true, price: true, image: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();

    return bookings.map((booking) => {
      const isHotel = booking.hotelId !== null;
      const checkInDate = new Date(booking.checkIn);
      const checkOutDate = new Date(booking.checkOut);

      // A booking is past if checkout date has passed
      const isPast = checkOutDate < now;

      // A booking is upcoming if check-in is in the future or currently ongoing
      const isUpcoming = checkInDate > now || (checkInDate <= now && checkOutDate >= now);

      return {
        id: booking.id,
        bookingReference: `BK${booking.id.toString().padStart(5, '0')}`,
        type: isHotel ? 'hotel' : 'property',
        status: booking.status,
        title: isHotel ? booking.hotel?.title : booking.property?.title,
        location: isHotel ? booking.hotel?.address : booking.property?.address,
        imageUrl: isHotel ? (booking.hotel?.images?.[0] || null) : (booking.property?.images?.[0] || null),
        hotelId: booking.hotelId,
        propertyId: booking.propertyId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalPrice: booking.totalPrice,
        room: booking.room,
        isPast,
        isUpcoming,
        createdAt: booking.createdAt,
      };
    });
  }

  async cancelBooking(bookingId: number, userId: number) {
    const booking = await this.prisma.booking.findFirst({
      where: {
        id: bookingId,
        userId,
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status === 'CANCELLED') {
      throw new BadRequestException('Booking is already cancelled');
    }

    // Determine refund amount based on 24hr rule (relative to when booking was placed)
    const now = new Date();
    const bookingTime = new Date(booking.createdAt);
    const msDiff = now.getTime() - bookingTime.getTime();
    const hoursDiff = msDiff / (1000 * 60 * 60);

    let refundAmount = Number(booking.totalPrice);
    let feeAmount = 0;

    if (hoursDiff > 24) {
      feeAmount = refundAmount * 0.05;
      refundAmount -= feeAmount;
    }

    // Use a transaction to ensure atomic update
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Update booking status
      const updatedBooking = await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELLED' },
      });

      // 2. Update user balance
      await tx.user.update({
        where: { id: userId },
        data: {
          balance: {
            increment: refundAmount,
          },
        },
      });

      // 3. Create transaction record
      await tx.transaction.create({
        data: {
          userId,
          bookingId,
          type: 'BOOKING_REFUND',
          amount: refundAmount,
          description: hoursDiff > 24 
            ? `Refund for booking #${bookingId} (5% cancellation fee applied)` 
            : `Full refund for booking #${bookingId}`,
        },
      });

      return updatedBooking;
    });

    return { 
      success: true, 
      message: 'Booking cancelled successfully', 
      refundAmount: refundAmount.toFixed(2), 
      feeAmount: feeAmount.toFixed(2),
      booking: result
    };
  }
}