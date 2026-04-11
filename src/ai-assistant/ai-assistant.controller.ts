import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { AiAssistantService } from './ai-assistant.service';
import { AuthGuard } from '@nestjs/passport';
import { ChatMessageDto } from './dto/chat-message.dto';
import { GetUser } from '../auth/get-user.decorator';
import type { User } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('ai-assistant')
export class AiAssistantController {
  constructor(private readonly aiAssistantService: AiAssistantService) {}

  @Get('recommendations')
  @UseGuards(AuthGuard('jwt'))
  async getRecommendations(@Query('type') type?: string) {
    return this.aiAssistantService.getRandomRecommendations(type);
  }

  @Get('investment-announcement')
  @UseGuards(AuthGuard('jwt'))
  async getInvestmentAnnouncement(@GetUser() user: User) {
    return this.aiAssistantService.getInvestmentAnnouncement(user.id);
  }

  @Post('chat')
  @UseGuards(AuthGuard('jwt'))
  async chat(@GetUser() user: User, @Body() dto: ChatMessageDto) {
    return this.aiAssistantService.chat(user.id, dto.message);
  }

  @Post('transcribe')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(
    FileInterceptor('audio', {
      limits: {
        fileSize: 10 * 1024 * 1024,
      },
    }),
  )
  async transcribe(
    @UploadedFile()
    file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Audio file is required');
    }

    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Audio file is empty');
    }

    const text = await this.aiAssistantService.transcribeAudio({
      audioBuffer: file.buffer,
      mimeType: file.mimetype,
    });

    return { text };
  }
}
