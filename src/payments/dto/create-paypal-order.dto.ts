import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';

export enum PaymentBookingType {
  HOTEL = 'hotel',
  PROPERTY = 'property',
}

export class CreatePaypalOrderDto {
  @IsEnum(PaymentBookingType)
  bookingType: PaymentBookingType;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @IsOptional()
  currency?: string;

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
