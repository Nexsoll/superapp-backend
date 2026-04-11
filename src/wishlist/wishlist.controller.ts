import { Controller, Post, Get, Delete, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from 'src/auth/get-user.decorator';
import type { User } from '@prisma/client';
import { WishlistService } from './wishlist.service';

@Controller('wishlist')
@UseGuards(AuthGuard('jwt'))
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Post('add-property/:propertyId')
  addPropertyToWishlist(
    @Param('propertyId') propertyId: string,
    @GetUser() user: User,
  ) {
    return this.wishlistService.addPropertyToWishlist(user.id, +propertyId);
  }

  @Post('add-hotel/:hotelId')
  addHotelToWishlist(
    @Param('hotelId') hotelId: string,
    @GetUser() user: User,
  ) {
    return this.wishlistService.addHotelToWishlist(user.id, +hotelId);
  }

  @Delete('remove-property/:propertyId')
  removePropertyFromWishlist(
    @Param('propertyId') propertyId: string,
    @GetUser() user: User,
  ) {
    return this.wishlistService.removePropertyFromWishlist(user.id, +propertyId);
  }

  @Delete('remove-hotel/:hotelId')
  removeHotelFromWishlist(
    @Param('hotelId') hotelId: string,
    @GetUser() user: User,
  ) {
    return this.wishlistService.removeHotelFromWishlist(user.id, +hotelId);
  }

  @Get('my-wishlist')
  getMyWishlist(@GetUser() user: User) {
    return this.wishlistService.getMyWishlist(user.id);
  }

  @Get('check-property/:propertyId')
  checkPropertyInWishlist(
    @Param('propertyId') propertyId: string,
    @GetUser() user: User,
  ) {
    return this.wishlistService.isPropertyInWishlist(user.id, +propertyId);
  }

  @Get('check-hotel/:hotelId')
  checkHotelInWishlist(
    @Param('hotelId') hotelId: string,
    @GetUser() user: User,
  ) {
    return this.wishlistService.isHotelInWishlist(user.id, +hotelId);
  }

  @Get('property-cost-breakdown/:propertyId')
  getPropertyCostBreakdown(
    @Param('propertyId') propertyId: string,
    @GetUser() user: User,
  ) {
    return this.wishlistService.getPropertyCostBreakdown(user.id, +propertyId);
  }
}
