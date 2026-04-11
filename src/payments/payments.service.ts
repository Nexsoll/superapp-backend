import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingStatus, Currency, type User } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { ConfirmCashPaymentDto } from './dto/confirm-cash-payment.dto';
import {
  CreatePaypalOrderDto,
  PaymentBookingType,
} from './dto/create-paypal-order.dto';
import { MailerService } from '../mailer/mailer.service';

type PaypalLink = {
  rel?: string;
  href?: string;
};

type PaypalOrderResponse = {
  id: string;
  status?: string;
  links?: PaypalLink[];
  payer?: {
    payer_id?: string;
    email_address?: string;
  };
  purchase_units?: Array<{
    custom_id?: string;
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
        custom_id?: string;
      }>;
    };
  }>;
};

type ParsedPaypalContext =
  | {
      bookingType: PaymentBookingType.HOTEL;
      userId: number;
      hotelId: number;
      bookingIds: number[];
    }
  | {
      bookingType: PaymentBookingType.PROPERTY;
      userId: number;
      propertyId: number;
      bookingId: number;
    };

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailerService: MailerService,
  ) {}

  async createPaypalOrder(user: User, dto: CreatePaypalOrderDto) {
    const currency = this.normalizeCurrency(dto.currency);

    if (dto.bookingType == PaymentBookingType.HOTEL) {
      return this.createHotelPaypalOrder(user, dto, currency);
    }

    return this.createPropertyPaypalOrder(user, dto, currency);
  }

  async capturePaypalOrder(user: User, orderId: string) {
    const captureResponse = await this.paypalRequest<PaypalOrderResponse>(
      `/v2/checkout/orders/${orderId}/capture`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    const purchaseUnit = captureResponse.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    const customId = capture?.custom_id?.trim() || purchaseUnit?.custom_id?.trim();

    if (!customId) {
      throw new BadRequestException('PayPal order context is missing');
    }

    const context = this.parsePaypalContext(customId);
    if (context.userId !== user.id) {
      throw new NotFoundException('Payment context does not belong to this user');
    }

    const captureId = purchaseUnit?.payments?.captures?.[0]?.id ?? null;
    const payerId = captureResponse.payer?.payer_id ?? null;
    const status = captureResponse.status ?? 'COMPLETED';

    if (context.bookingType == PaymentBookingType.HOTEL) {
      await this.prisma.booking.updateMany({
        where: {
          id: { in: context.bookingIds },
          userId: user.id,
          hotelId: context.hotelId,
          status: BookingStatus.PENDING,
        },
        data: {
          status: BookingStatus.ACTIVE,
        },
      });

      // Fetch booking details for email
      const bookings = await this.prisma.booking.findMany({
        where: {
          id: { in: context.bookingIds },
          userId: user.id,
        },
        include: {
          hotel: true,
          room: true,
        },
      });

      if (bookings.length > 0) {
        const firstBooking = bookings[0];
        const hotel = firstBooking.hotel;
        const rooms = bookings.map(b => b.room?.title || 'Room').filter(Boolean);
        const totalAmount = bookings.reduce((sum, b) => sum + Number(b.totalPrice), 0);

        // Send confirmation email
        try {
          await this.mailerService.sendBookingConfirmation({
            email: user.email,
            bookingReference: captureId || orderId,
            bookingType: 'hotel',
            listingTitle: hotel?.title || 'Hotel Booking',
            location: hotel?.address || '',
            checkIn: firstBooking.checkIn.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            checkOut: firstBooking.checkOut.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            guests: bookings.length * 2,
            rooms,
            totalAmount: `$${totalAmount.toFixed(2)}`,
            paymentMethod: 'PayPal',
          });
        } catch (emailError) {
          console.error('Failed to send confirmation email:', emailError);
        }

        // Create transaction record
        await this.prisma.transaction.create({
          data: {
            userId: user.id,
            type: 'BOOKING_PAYMENT',
            amount: totalAmount,
            description: `Payment for hotel booking at ${hotel?.title || 'Hotel'} (${orderId})`,
          },
        });
      }

      return {
        success: true,
        message: 'PayPal payment captured successfully',
        payment: {
          provider: 'paypal',
          orderId,
          captureId,
          status,
          payerId,
        },
        booking: {
          bookingType: PaymentBookingType.HOTEL,
          hotelId: context.hotelId,
          bookingIds: context.bookingIds,
        },
      };
    }

    const propertyBooking = await this.prisma.booking.findFirst({
      where: {
        id: context.bookingId,
        userId: user.id,
        propertyId: context.propertyId,
      },
      include: {
        property: true,
      },
    });

    if (!propertyBooking) {
      throw new NotFoundException('Property booking was not found');
    }

    if (propertyBooking.status == BookingStatus.PENDING) {
      await this.prisma.booking.update({
        where: { id: propertyBooking.id },
        data: { status: BookingStatus.ACTIVE },
      });
    }

    // Send confirmation email
    if (propertyBooking.property) {
      try {
        await this.mailerService.sendBookingConfirmation({
          email: user.email,
          bookingReference: captureId || orderId,
          bookingType: 'property',
          listingTitle: propertyBooking.property.title,
          location: propertyBooking.property.address || '',
          checkIn: propertyBooking.checkIn.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          checkOut: propertyBooking.checkOut.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          totalAmount: `$${Number(propertyBooking.totalPrice).toFixed(2)}`,
          paymentMethod: 'PayPal',
        });
      } catch (emailError) {
        console.error('Failed to send confirmation email:', emailError);
      }
    }

    // Create transaction record
    await this.prisma.transaction.create({
      data: {
        userId: user.id,
        bookingId: propertyBooking.id,
        type: 'BOOKING_PAYMENT',
        amount: Number(propertyBooking.totalPrice),
        description: `Payment for property booking at ${propertyBooking.property?.title || 'Property'} (${orderId})`,
      },
    });

    return {
      success: true,
      message: 'PayPal payment captured successfully',
      payment: {
        provider: 'paypal',
        orderId,
        captureId,
        status,
        payerId,
      },
      booking: {
        bookingType: PaymentBookingType.PROPERTY,
        propertyId: context.propertyId,
        bookingIds: [context.bookingId],
      },
    };
  }

  async confirmCashPayment(user: User, dto: ConfirmCashPaymentDto) {
    const referenceId = `CASH-${Date.now()}-${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`;

    if (dto.bookingType == PaymentBookingType.HOTEL) {
      if (!dto.bookingIds || dto.bookingIds.length == 0) {
        throw new BadRequestException('Hotel booking ids are required');
      }

      const bookings = await this.prisma.booking.findMany({
        where: {
          id: { in: dto.bookingIds },
          userId: user.id,
          hotelId: { not: null },
          status: BookingStatus.PENDING,
        },
        include: {
          hotel: true,
          room: true,
        },
      });

      if (bookings.length !== dto.bookingIds.length) {
        throw new BadRequestException(
          'One or more hotel bookings are invalid or no longer pending',
        );
      }

      const hotelId = bookings[0]?.hotelId;
      if (!hotelId) {
        throw new BadRequestException('Hotel booking context is invalid');
      }

      if (!bookings.every((booking) => booking.hotelId == hotelId)) {
        throw new BadRequestException('Please confirm one hotel at a time');
      }

      const roomSubtotal = bookings.reduce(
        (sum, booking) => sum + Number(booking.totalPrice),
        0,
      );
      const nights = Math.max(
        1,
        Math.ceil(
          (bookings[0].checkOut.getTime() - bookings[0].checkIn.getTime()) /
            (1000 * 60 * 60 * 24),
        ),
      );
      const roomCount = bookings.length;
      const adults = dto.adults ?? roomCount * 2;
      const children = dto.children ?? 0;
      const extraAdults = Math.max(0, adults - roomCount * 2);
      const guestCharge = ((extraAdults * 20) + (children * 10)) * nights;
      const subtotalBeforeTax = roomSubtotal + guestCharge;
      const taxes = subtotalBeforeTax * 0.10;
      const serviceCharge = subtotalBeforeTax > 0 ? 25 : 0;
      const amount = Number(
        (subtotalBeforeTax + taxes + serviceCharge).toFixed(2),
      );

      await this.prisma.booking.updateMany({
        where: {
          id: { in: dto.bookingIds },
          userId: user.id,
          hotelId,
          status: BookingStatus.PENDING,
        },
        data: {
          status: BookingStatus.ACTIVE,
        },
      });

      const firstBooking = bookings[0];
      const hotel = firstBooking.hotel;
      const rooms = bookings
        .map((booking) => booking.room?.title || 'Room')
        .filter(Boolean);

      try {
        await this.mailerService.sendBookingConfirmation({
          email: user.email,
          bookingReference: referenceId,
          bookingType: 'hotel',
          listingTitle: hotel?.title || 'Hotel Booking',
          location: hotel?.address || '',
          checkIn: firstBooking.checkIn.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          }),
          checkOut: firstBooking.checkOut.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          }),
          guests: adults + children,
          rooms,
          totalAmount: `$${amount.toFixed(2)}`,
          paymentMethod: 'Cash Payment',
        });
      } catch (emailError) {
        console.error('Failed to send confirmation email:', emailError);
      }

      await this.prisma.transaction.create({
        data: {
          userId: user.id,
          type: 'BOOKING_PAYMENT',
          amount,
          description: `Cash payment for hotel booking at ${hotel?.title || 'Hotel'} (${referenceId})`,
        },
      });

      return {
        success: true,
        message: 'Cash payment confirmed successfully',
        payment: {
          provider: 'cash',
          referenceId,
          status: 'CONFIRMED',
        },
        booking: {
          bookingType: PaymentBookingType.HOTEL,
          hotelId,
          bookingIds: dto.bookingIds,
        },
      };
    }

    if (!dto.propertyId) {
      throw new BadRequestException('Property id is required');
    }

    const property = await this.prisma.property.findUnique({
      where: { id: dto.propertyId },
    });

    if (!property) {
      throw new NotFoundException('Property not found');
    }

    const purchasePrice = Number(property.price);
    const closingCosts = purchasePrice * 0.0148;
    const agentFees = purchasePrice * 0.03;
    const estimatedAmount = Number((purchasePrice + closingCosts + agentFees).toFixed(2));

    let propertyBooking = await this.prisma.booking.findFirst({
      where: {
        userId: user.id,
        propertyId: property.id,
        status: BookingStatus.PENDING,
      },
      include: {
        property: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (propertyBooking) {
      propertyBooking = await this.prisma.booking.update({
        where: { id: propertyBooking.id },
        data: { status: BookingStatus.ACTIVE },
        include: {
          property: true,
        },
      });
    } else {
      const checkIn = new Date();
      const checkOut = new Date(checkIn.getTime() + 24 * 60 * 60 * 1000);
      propertyBooking = await this.prisma.booking.create({
        data: {
          userId: user.id,
          propertyId: property.id,
          checkIn,
          checkOut,
          totalPrice: estimatedAmount,
          status: BookingStatus.ACTIVE,
        },
        include: {
          property: true,
        },
      });
    }

    const finalAmount = Number(propertyBooking.totalPrice);

    try {
      await this.mailerService.sendBookingConfirmation({
        email: user.email,
        bookingReference: referenceId,
        bookingType: 'property',
        listingTitle: propertyBooking.property?.title || 'Property Booking',
        location: propertyBooking.property?.address || '',
        checkIn: propertyBooking.checkIn.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        checkOut: propertyBooking.checkOut.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        totalAmount: `$${finalAmount.toFixed(2)}`,
        paymentMethod: 'Cash Payment',
      });
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }

    await this.prisma.transaction.create({
      data: {
        userId: user.id,
        bookingId: propertyBooking.id,
        type: 'BOOKING_PAYMENT',
        amount: finalAmount,
        description: `Cash payment for property booking at ${propertyBooking.property?.title || 'Property'} (${referenceId})`,
      },
    });

    return {
      success: true,
      message: 'Cash payment confirmed successfully',
      payment: {
        provider: 'cash',
        referenceId,
        status: 'CONFIRMED',
      },
      booking: {
        bookingType: PaymentBookingType.PROPERTY,
        propertyId: property.id,
        bookingIds: [propertyBooking.id],
      },
    };
  }

  private async createHotelPaypalOrder(
    user: User,
    dto: CreatePaypalOrderDto,
    currency: Currency,
  ) {
    if (!dto.bookingIds || dto.bookingIds.length == 0) {
      throw new BadRequestException('Hotel booking ids are required');
    }

    const bookings = await this.prisma.booking.findMany({
      where: {
        id: { in: dto.bookingIds },
        userId: user.id,
        hotelId: { not: null },
        status: BookingStatus.PENDING,
      },
      include: {
        hotel: true,
      },
    });

    if (bookings.length !== dto.bookingIds.length) {
      throw new BadRequestException(
        'One or more hotel bookings are invalid or no longer pending',
      );
    }

    const hotelId = bookings[0]?.hotelId;
    if (!hotelId) {
      throw new BadRequestException('Hotel booking context is invalid');
    }

    if (!bookings.every((booking) => booking.hotelId == hotelId)) {
      throw new BadRequestException('Please pay bookings from one hotel at a time');
    }

    const roomSubtotal = bookings.reduce(
      (sum, booking) => sum + Number(booking.totalPrice),
      0,
    );
    const nights = Math.max(
      1,
      Math.ceil(
        (bookings[0].checkOut.getTime() - bookings[0].checkIn.getTime()) /
          (1000 * 60 * 60 * 24),
      ),
    );
    const roomCount = bookings.length;
    const adults = dto.adults ?? roomCount * 2;
    const children = dto.children ?? 0;
    const extraAdults = Math.max(0, adults - roomCount * 2);
    const guestCharge = ((extraAdults * 20) + (children * 10)) * nights;
    const subtotalBeforeTax = roomSubtotal + guestCharge;
    const taxes = subtotalBeforeTax * 0.10;
    const serviceCharge = subtotalBeforeTax > 0 ? 25 : 0;
    const amount = Number(
      (subtotalBeforeTax + taxes + serviceCharge).toFixed(2),
    );

    const orderResponse = await this.createPaypalCheckoutOrder({
      amount,
      currency,
      description: bookings[0]?.hotel?.title ?? 'Hotel Booking',
      customId: `hotel:${user.id}:${hotelId}:${dto.bookingIds.join(',')}:${Date.now()}`,
    });

    return {
      success: true,
      orderId: orderResponse.id,
      approvalUrl: this.findApprovalUrl(orderResponse.links),
      status: orderResponse.status ?? 'CREATED',
      currency,
      amount,
      returnUrl: this.paypalReturnUrl,
      cancelUrl: this.paypalCancelUrl,
    };
  }

  private async createPropertyPaypalOrder(
    user: User,
    dto: CreatePaypalOrderDto,
    currency: Currency,
  ) {
    if (!dto.propertyId) {
      throw new BadRequestException('Property id is required');
    }

    const property = await this.prisma.property.findUnique({
      where: { id: dto.propertyId },
    });

    if (!property) {
      throw new NotFoundException('Property not found');
    }

    const purchasePrice = Number(property.price);
    const closingCosts = purchasePrice * 0.0148;
    const agentFees = purchasePrice * 0.03;
    const amount = Number((purchasePrice + closingCosts + agentFees).toFixed(2));

    const checkIn = new Date();
    const checkOut = new Date(checkIn.getTime() + 24 * 60 * 60 * 1000);
    const booking = await this.prisma.booking.create({
      data: {
        userId: user.id,
        propertyId: property.id,
        checkIn,
        checkOut,
        totalPrice: amount,
        status: BookingStatus.PENDING,
      },
    });

    try {
      const orderResponse = await this.createPaypalCheckoutOrder({
        amount,
        currency,
        description: property.title,
        customId: `property:${user.id}:${property.id}:${booking.id}:${Date.now()}`,
      });

      return {
        success: true,
        orderId: orderResponse.id,
        approvalUrl: this.findApprovalUrl(orderResponse.links),
        status: orderResponse.status ?? 'CREATED',
        currency,
        amount,
        bookingId: booking.id,
        returnUrl: this.paypalReturnUrl,
        cancelUrl: this.paypalCancelUrl,
      };
    } catch (error) {
      await this.prisma.booking.delete({
        where: { id: booking.id },
      });
      throw error;
    }
  }

  private async createPaypalCheckoutOrder({
    amount,
    currency,
    description,
    customId,
  }: {
    amount: number;
    currency: Currency;
    description: string;
    customId: string;
  }) {
    return this.paypalRequest<PaypalOrderResponse>('/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: customId,
            description: description,
            amount: {
              currency_code: currency,
              value: amount.toFixed(2),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Super App',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: this.paypalReturnUrl,
              cancel_url: this.paypalCancelUrl,
            },
          },
        },
      }),
    });
  }

  private async paypalRequest<T>(path: string, init: RequestInit): Promise<T> {
    const accessToken = await this.getPaypalAccessToken();

    // Debug logging
    console.log('PayPal Request:', {
      url: `${this.paypalBaseUrl}${path}`,
      method: init.method,
      body: init.body,
    });

    const response = await fetch(`${this.paypalBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    // Debug logging
    console.log('PayPal Response:', {
      status: response.status,
      data: JSON.stringify(data, null, 2),
    });

    if (!response.ok) {
      console.error('PayPal Error:', data);
      throw new BadRequestException(
        data?.message || data?.details?.[0]?.description || 'PayPal request failed',
      );
    }

    return data as T;
  }

  private async getPaypalAccessToken() {
    const clientId = this.configService.get<string>('PAYPAL_CLIENT_ID')?.trim();
    const clientSecret = this.configService
      .get<string>('PAYPAL_CLIENT_SECRET')
      ?.trim();

    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException(
        'PayPal credentials are not configured',
      );
    }

    const response = await fetch(`${this.paypalBaseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok || !data?.access_token) {
      throw new InternalServerErrorException(
        data?.error_description || data?.error || 'Unable to authenticate PayPal',
      );
    }

    return data.access_token as string;
  }

  private findApprovalUrl(links?: PaypalLink[]) {
    const approvalUrl = links?.find((link) => link.rel == 'approve' || link.rel == 'payer-action')?.href;

    if (!approvalUrl) {
      throw new InternalServerErrorException(
        'PayPal approval url was not returned',
      );
    }

    return approvalUrl;
  }

  private parsePaypalContext(customId: string): ParsedPaypalContext {
    const parts = customId.split(':');

    if (parts[0] == PaymentBookingType.HOTEL && parts.length >= 4) {
      const userId = Number(parts[1]);
      const hotelId = Number(parts[2]);
      const bookingIds = parts[3]
        .split(',')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);

      if (userId > 0 && hotelId > 0 && bookingIds.length > 0) {
        return {
          bookingType: PaymentBookingType.HOTEL,
          userId,
          hotelId,
          bookingIds,
        };
      }
    }

    if (parts[0] == PaymentBookingType.PROPERTY && parts.length >= 4) {
      const userId = Number(parts[1]);
      const propertyId = Number(parts[2]);
      const bookingId = Number(parts[3]);

      if (userId > 0 && propertyId > 0 && bookingId > 0) {
        return {
          bookingType: PaymentBookingType.PROPERTY,
          userId,
          propertyId,
          bookingId,
        };
      }
    }

    throw new BadRequestException('Invalid PayPal payment context');
  }

  private normalizeCurrency(currency?: string) {
    const normalized = (currency ?? 'USD').toUpperCase();

    if (normalized !== Currency.USD && normalized !== Currency.EUR) {
      throw new BadRequestException('Only USD and EUR are supported for PayPal');
    }

    return normalized as Currency;
  }

  private get paypalBaseUrl() {
    const env = this.configService.get<string>('PAYPAL_ENV')?.toLowerCase();
    return env == 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  private get paypalReturnUrl() {
    return (
      this.configService.get<string>('PAYPAL_RETURN_URL') ||
      'superapp://paypal/success'
    );
  }

  private get paypalCancelUrl() {
    return (
      this.configService.get<string>('PAYPAL_CANCEL_URL') ||
      'superapp://paypal/cancel'
    );
  }

  async getMyTransactions(user: User) {
    return this.prisma.transaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        booking: {
          include: {
            hotel: true,
            property: true,
          },
        },
      },
    });
  }
}
