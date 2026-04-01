import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { User } from '@prisma/client';
import type { Response } from 'express';
import { GetUser } from 'src/auth/get-user.decorator';
import { CapturePaypalOrderDto } from './dto/capture-paypal-order.dto';
import { CreatePaypalOrderDto } from './dto/create-paypal-order.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('paypal/return')
  paypalReturn(@Query() query: Record<string, string>, @Res() res: Response) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (typeof value === 'string' && value.trim().length > 0) {
        params.set(key, value);
      }
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return res.redirect(302, `superapp://paypal/success${suffix}`);
  }

  @Get('paypal/cancel')
  paypalCancel(@Query() query: Record<string, string>, @Res() res: Response) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (typeof value === 'string' && value.trim().length > 0) {
        params.set(key, value);
      }
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return res.redirect(302, `superapp://paypal/cancel${suffix}`);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('paypal/create-order')
  createPaypalOrder(
    @Body() dto: CreatePaypalOrderDto,
    @GetUser() user: User,
  ) {
    return this.paymentsService.createPaypalOrder(user, dto);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('paypal/capture-order')
  capturePaypalOrder(
    @Body() dto: CapturePaypalOrderDto,
    @GetUser() user: User,
  ) {
    return this.paymentsService.capturePaypalOrder(user, dto.orderId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('transactions')
  getMyTransactions(@GetUser() user: User) {
    return this.paymentsService.getMyTransactions(user);
  }
}
