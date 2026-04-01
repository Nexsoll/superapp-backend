import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  NotFoundException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import { ListingService } from './listings.service';
import { StorageService } from '../storage/storage.service';
import { CreatePropertyDto } from './dto/create-property.dto';
import { UpdatePropertyDto } from './dto/update-property.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from 'src/auth/get-user.decorator';
import type { User } from '@prisma/client';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';
import { CreateHotelBookingDto } from './dto/create-hotel-booking.dto';
import type { Response } from 'express';

@Controller('listing')
export class ListingController {
  constructor(
    private readonly listingService: ListingService,
    private readonly storageService: StorageService,
  ) {}

  @UseGuards(AuthGuard('jwt'))
  @Get('owner-summary')
  getOwnerSummary(@GetUser() user: User) {
    return this.listingService.getOwnerListingSummary(user.id);
  }

  // ─── Properties ────────────────────────────────────────

  @UseGuards(AuthGuard('jwt'))
  @Post('add-property')
  @UseInterceptors(FilesInterceptor('images', 5)) // max 5 images
  async createProperty(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: CreatePropertyDto,
    @GetUser() user: User,
  ) {
    let imageUrls: string[] = [];

    if (files && files.length > 0) {
      imageUrls = await this.storageService.uploadMultipleImages(
        files,
        'properties',
      );
    }

    dto.images = imageUrls;
    return this.listingService.createProperty(dto, user.id);
  }

  @Get('get-all-properties')
  getAllProperties() {
    return this.listingService.getAllProperties();
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('get-my-properties')
  getMyProperties(@GetUser() user: User) {
    return this.listingService.getMyProperties(user.id);
  }

  @Get('property/:id')
  getPropertyById(@Param('id') id: string) {
    return this.listingService.getPropertyById(+id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('update-property/:id')
  @UseInterceptors(FilesInterceptor('images', 5))
  async updateProperty(
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: UpdatePropertyDto,
    @GetUser() user: User,
  ) {
    let imageUrls: string[] = [];

    if (files && files.length > 0) {
      imageUrls = await this.storageService.uploadMultipleImages(
        files,
        'properties',
      );
    }

    if (imageUrls.length > 0) {
      const existingProperty = await this.listingService.getPropertyById(+id);
      dto.images = [...(existingProperty.images || []), ...imageUrls];
    }

    return this.listingService.updateProperty(+id, dto, user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete('delete-property/:id')
  deleteProperty(@Param('id') id: string, @GetUser() user: User) {
    return this.listingService.deleteProperty(+id, user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('toggle-property-status/:id')
  togglePropertyStatus(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
    @GetUser() user: User,
  ) {
    return this.listingService.updateProperty(+id, { isActive }, user.id);
  }

  // ─── AI Property Analysis ─────────────────────────────
  @Get('property-analysis/:id')
  analyzeProperty(@Param('id') id: string) {
    return this.listingService.analyzeProperty(+id);
  }

  // ─── Property image proxy (GCS bucket is private) ──────
  @Get('property-image/:propertyId/:imageIndex')
  async getPropertyImage(
    @Param('propertyId') propertyId: string,
    @Param('imageIndex') imageIndex: string,
    @Res() res: Response,
  ) {
    const property = await this.listingService.getPropertyById(+propertyId);
    const idx = +imageIndex;
    if (!property.images || idx < 0 || idx >= property.images.length) {
      throw new NotFoundException('Image not found');
    }

    const imageUrl = property.images[idx];
    const fileData =
      await this.storageService.getFileStreamAndContentTypeFromPublicUrl(
        imageUrl,
      );
    if (!fileData) {
      throw new NotFoundException('Image not found');
    }

    res.setHeader(
      'Content-Type',
      fileData.contentType ?? 'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fileData.stream.on('error', () => {
      res.status(404).end();
    });
    fileData.stream.pipe(res);
  }

  // ─── Hotels ────────────────────────────────────────────

  @UseGuards(AuthGuard('jwt'))
  @Post('add-hotel')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'images', maxCount: 5 },
      { name: 'roomImages', maxCount: 20 },
    ]),
  )
  async createHotel(
    @UploadedFiles()
    files: {
      images?: Express.Multer.File[];
      roomImages?: Express.Multer.File[];
    },
    @Body() dto: CreateHotelDto,
    @GetUser() user: User,
  ) {
    let imageUrls: string[] = [];

    if (files?.images && files.images.length > 0) {
      imageUrls = await this.storageService.uploadMultipleImages(
        files.images,
        'hotels',
      );
    }

    // Upload room images
    let roomImageUrls: string[] = [];
    if (files?.roomImages && files.roomImages.length > 0) {
      roomImageUrls = await this.storageService.uploadMultipleImages(
        files.roomImages,
        'rooms',
      );
    }

    // Parse rooms JSON if provided (sent as string in multipart form)
    let rooms: {
      title: string;
      price: number;
      image?: string;
      imageIndex?: number;
    }[] = [];
    const rawRooms = (dto as any).rooms;
    if (rawRooms) {
      try {
        rooms = typeof rawRooms === 'string' ? JSON.parse(rawRooms) : rawRooms;
      } catch {
        rooms = [];
      }
    }

    // Attach uploaded room image URLs to rooms using the imageIndex sent from frontend
    rooms = rooms.map((room) => {
      let imageUrl: string | undefined;
      // If room has an imageIndex and we have uploaded images, pick the correct one
      if (
        typeof room.imageIndex === 'number' &&
        room.imageIndex >= 0 &&
        roomImageUrls[room.imageIndex]
      ) {
        imageUrl = roomImageUrls[room.imageIndex];
      }

      // Clean up the temp field and assign image
      const { imageIndex, ...rest } = room;
      return {
        ...rest,
        image: imageUrl,
      };
    });

    const hotelData = { ...dto, images: imageUrls };
    delete (hotelData as any).rooms; // remove rooms from hotel data
    return this.listingService.createHotel(
      hotelData as CreateHotelDto,
      user.id,
      rooms,
    );
  }

  @Get('get-all-hotels')
  getAllHotels() {
    return this.listingService.getAllHotels();
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('get-my-hotels')
  getMyHotels(@GetUser() user: User) {
    return this.listingService.getMyHotels(user.id);
  }

  @Get('hotel/:id')
  getHotelById(@Param('id') id: string) {
    return this.listingService.getHotelById(+id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('update-hotel/:id')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'images', maxCount: 5 },
      { name: 'roomImages', maxCount: 20 },
    ]),
  )
  async updateHotel(
    @Param('id') id: string,
    @UploadedFiles()
    files: {
      images?: Express.Multer.File[];
      roomImages?: Express.Multer.File[];
    },
    @Body() dto: UpdateHotelDto,
    @GetUser() user: User,
  ) {
    let imageUrls: string[] = [];

    if (files?.images && files.images.length > 0) {
      imageUrls = await this.storageService.uploadMultipleImages(
        files.images,
        'hotels',
      );
    }

    // Upload room images
    let roomImageUrls: string[] = [];
    if (files?.roomImages && files.roomImages.length > 0) {
      roomImageUrls = await this.storageService.uploadMultipleImages(
        files.roomImages,
        'rooms',
      );
    }

    // Parse rooms JSON
    let rooms: {
      title: string;
      price: number;
      image?: string;
      imageIndex?: number;
    }[] = [];
    const rawRooms = (dto as any).rooms;
    if (rawRooms) {
      try {
        rooms = typeof rawRooms === 'string' ? JSON.parse(rawRooms) : rawRooms;
      } catch {
        rooms = [];
      }
    }

    // Attach uploaded room image URLs to rooms using the imageIndex
    rooms = rooms.map((room) => {
      let imageUrl = room.image; // default to existing image
      if (
        typeof room.imageIndex === 'number' &&
        room.imageIndex >= 0 &&
        roomImageUrls[room.imageIndex]
      ) {
        imageUrl = roomImageUrls[room.imageIndex];
      }

      const { imageIndex, ...rest } = room;
      return {
        ...rest,
        image: imageUrl,
      };
    });

    const updateData = { ...dto };
    if (imageUrls.length > 0) {
      const existingHotel = await this.listingService.getHotelById(+id);
      updateData.images = [...(existingHotel.images || []), ...imageUrls];
    }
    delete (updateData as any).rooms;

    return this.listingService.updateHotel(+id, updateData, user.id, rooms);
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete('delete-hotel/:id')
  deleteHotel(@Param('id') id: string, @GetUser() user: User) {
    return this.listingService.deleteHotel(+id, user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('toggle-hotel-status/:id')
  toggleHotelStatus(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
    @GetUser() user: User,
  ) {
    return this.listingService.updateHotel(+id, { isActive }, user.id);
  }

  // ─── Hotel image proxy (GCS bucket is private) ─────────
  @Get('hotel-image/:hotelId/:imageIndex')
  async getHotelImage(
    @Param('hotelId') hotelId: string,
    @Param('imageIndex') imageIndex: string,
    @Res() res: Response,
  ) {
    const hotel = await this.listingService.getHotelById(+hotelId);
    const idx = +imageIndex;
    if (!hotel.images || idx < 0 || idx >= hotel.images.length) {
      throw new NotFoundException('Image not found');
    }

    const imageUrl = hotel.images[idx];
    const fileData =
      await this.storageService.getFileStreamAndContentTypeFromPublicUrl(
        imageUrl,
      );
    if (!fileData) {
      throw new NotFoundException('Image not found');
    }

    res.setHeader(
      'Content-Type',
      fileData.contentType ?? 'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fileData.stream.on('error', () => {
      res.status(404).end();
    });
    fileData.stream.pipe(res);
  }

  // ─── Room image proxy (GCS bucket is private) ─────────
  @Get('room-image/:roomId')
  async getRoomImage(@Param('roomId') roomId: string, @Res() res: Response) {
    const room: any = await this.listingService.getRoomById(+roomId);
    if (!room || !room.image) {
      throw new NotFoundException('Room image not found');
    }

    const fileData =
      await this.storageService.getFileStreamAndContentTypeFromPublicUrl(
        room.image,
      );
    if (!fileData) {
      throw new NotFoundException('Room image not found');
    }

    res.setHeader(
      'Content-Type',
      fileData.contentType ?? 'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fileData.stream.on('error', () => {
      res.status(404).end();
    });
    fileData.stream.pipe(res);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('hotel-bookings')
  createHotelBooking(
    @Body() dto: CreateHotelBookingDto,
    @GetUser() user: User,
  ) {
    return this.listingService.createHotelBooking(dto, user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('bookings')
  getUserBookings(@GetUser() user: User) {
    return this.listingService.getUserBookings(user.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('bookings/:id/cancel')
  cancelBooking(@Param('id') id: string, @GetUser() user: User) {
    return this.listingService.cancelBooking(parseInt(id), user.id);
  }

  // ─── Avatar image proxy (GCS bucket is private) ───────
  @Get('avatar-image/:filename')
  async getAvatarImage(
    @Param('filename') filename: string,
    @Res() res: Response,
  ) {
    // Construct the full GCS URL from the filename
    const avatarUrl = `https://storage.googleapis.com/superapp_images/avatars/${filename}`;

    const fileData =
      await this.storageService.getFileStreamAndContentTypeFromPublicUrl(
        avatarUrl,
      );
    if (!fileData) {
      throw new NotFoundException('Avatar image not found');
    }

    res.setHeader(
      'Content-Type',
      fileData.contentType ?? 'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fileData.stream.on('error', () => {
      res.status(404).end();
    });
    fileData.stream.pipe(res);
  }
}
