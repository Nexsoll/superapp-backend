import { IsString } from 'class-validator';

export class CapturePaypalOrderDto {
  @IsString()
  orderId: string;
}
