import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  UploadedFile,
  UseInterceptors,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/get-user.decorator';
import type { User } from '@prisma/client';
import { UpdateFcmTokenDto } from './dto/update-fcm-token.dto';
import { StorageService } from '../storage/storage.service';
import type { Response } from 'express';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly storageService: StorageService,
  ) { }

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  findAll(@Query('q') q?: string) {
    return this.usersService.findAll({ q });
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  getMe(@GetUser() user: User) {
    return this.usersService.findOne(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(+id);
  }

  @Get(':id/avatar')
  async getAvatar(@Param('id') id: string, @Res() res: Response) {
    const user = await this.usersService.findOne(+id);
    if (!user || !(user as any).avatar) {
      throw new NotFoundException('Avatar not found');
    }

    const avatarUrl = (user as any).avatar as string;
    const fileData = await this.storageService.getFileStreamAndContentTypeFromPublicUrl(
      avatarUrl,
    );
    if (!fileData) {
      throw new NotFoundException('Avatar not found');
    }

    res.setHeader('Content-Type', fileData.contentType ?? 'application/octet-stream');
    fileData.stream.on('error', () => {
      res.status(404).end();
    });
    fileData.stream.pipe(res);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(+id, updateUserDto);
  }

  @Patch(':id/avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  async updateAvatar(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    let avatarUrl = '';
    
    if (file) {
      avatarUrl = await this.storageService.uploadImage(file, 'avatars');
    }
    
    return this.usersService.update(+id, { avatar: avatarUrl });
  }

  @Patch('me/fcm-token')
  @UseGuards(AuthGuard('jwt'))
  updateMyFcmToken(@GetUser() user: User, @Body() dto: UpdateFcmTokenDto) {
    return this.usersService.updateFcmToken(user.id, dto.fcmToken);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(+id);
  }
}
