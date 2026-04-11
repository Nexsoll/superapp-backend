import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';
import { PaymentBookingType } from './create-paypal-order.dto';

export class ConfirmCashPaymentDto {
  @IsEnum(PaymentBookingType)
  bookingType: PaymentBookingType;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  bookingIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  propertyId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  adults?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  children?: number;
}