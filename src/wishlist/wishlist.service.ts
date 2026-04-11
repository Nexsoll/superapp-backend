import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { GoogleGenerativeAI } from '@google/generative-ai';

const prisma = new PrismaClient();

@Injectable()
export class WishlistService {
  private readonly logger = new Logger(WishlistService.name);
  private readonly genAI?: GoogleGenerativeAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY') || '';
    if (apiKey.trim().length > 0) {
      this.genAI = new GoogleGenerativeAI(apiKey);
    }
  }

  async addPropertyToWishlist(userId: number, propertyId: number) {
    // Check if property exists
    const property = await prisma.property.findUnique({
      where: { id: propertyId },
    });

    if (!property) {
      throw new NotFoundException('Property not found');
    }

    // Check if already in wishlist
    const existing = await prisma.wishlist.findUnique({
      where: {
        userId_propertyId: {
          userId,
          propertyId,
        },
      },
    });

    if (existing) {
      throw new ConflictException('Property already in wishlist');
    }

    return prisma.wishlist.create({
      data: {
        userId,
        propertyId,
      },
    });
  }

  async addHotelToWishlist(userId: number, hotelId: number) {
    // Check if hotel exists
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
    });

    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }

    // Check if already in wishlist
    const existing = await prisma.wishlist.findUnique({
      where: {
        userId_hotelId: {
          userId,
          hotelId,
        },
      },
    });

    if (existing) {
      throw new ConflictException('Hotel already in wishlist');
    }

    return prisma.wishlist.create({
      data: {
        userId,
        hotelId,
      },
    });
  }

  async removePropertyFromWishlist(userId: number, propertyId: number) {
    const wishlistItem = await prisma.wishlist.findUnique({
      where: {
        userId_propertyId: {
          userId,
          propertyId,
        },
      },
    });

    if (!wishlistItem) {
      throw new NotFoundException('Property not in wishlist');
    }

    return prisma.wishlist.delete({
      where: {
        id: wishlistItem.id,
      },
    });
  }

  async removeHotelFromWishlist(userId: number, hotelId: number) {
    const wishlistItem = await prisma.wishlist.findUnique({
      where: {
        userId_hotelId: {
          userId,
          hotelId,
        },
      },
    });

    if (!wishlistItem) {
      throw new NotFoundException('Hotel not in wishlist');
    }

    return prisma.wishlist.delete({
      where: {
        id: wishlistItem.id,
      },
    });
  }

  async getMyWishlist(userId: number) {
    const wishlists = await prisma.wishlist.findMany({
      where: { userId },
      include: {
        property: true,
        hotel: {
          include: {
            rooms: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      properties: wishlists.filter((w) => w.property).map((w) => w.property),
      hotels: wishlists.filter((w) => w.hotel).map((w) => w.hotel),
    };
  }

  async isPropertyInWishlist(userId: number, propertyId: number) {
    const wishlistItem = await prisma.wishlist.findUnique({
      where: {
        userId_propertyId: {
          userId,
          propertyId,
        },
      },
    });

    return { inWishlist: !!wishlistItem };
  }

  async isHotelInWishlist(userId: number, hotelId: number) {
    const wishlistItem = await prisma.wishlist.findUnique({
      where: {
        userId_hotelId: {
          userId,
          hotelId,
        },
      },
    });

    return { inWishlist: !!wishlistItem };
  }

  async getPropertyCostBreakdown(userId: number, propertyId: number) {
    if (!Number.isFinite(propertyId) || propertyId <= 0) {
      throw new BadRequestException('Invalid property id');
    }

    const savedProperty = await prisma.wishlist.findUnique({
      where: {
        userId_propertyId: {
          userId,
          propertyId,
        },
      },
      include: {
        property: {
          include: {
            reviews: {
              select: { rating: true },
            },
            wishlists: {
              select: { id: true },
            },
            bookings: {
              select: { id: true, createdAt: true },
            },
          },
        },
      },
    });

    if (!savedProperty || !savedProperty.property) {
      throw new NotFoundException('Property not found in your wishlist');
    }

    const property = savedProperty.property;
    const priceUsd = Number(property.price || 0);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new BadRequestException('Property price is missing or invalid');
    }

    const ratingCount = property.reviews.length;
    const ratingAverage =
      ratingCount > 0
        ? property.reviews.reduce((sum, review) => sum + Number(review.rating), 0) /
          ratingCount
        : 0;

    const baseEstimate = this.buildBaseCostEstimate(priceUsd);
    const aiEstimate = await this.generateGeminiCostBreakdown({
      propertyId: property.id,
      title: property.title,
      address: property.address || 'Unknown',
      priceUsd,
      rooms: property.rooms ?? 0,
      bathrooms: property.bathrooms ?? 0,
      area: property.area ?? 0,
      ratingAverage,
      ratingCount,
      wishlistCount: property.wishlists.length,
      bookingCount: property.bookings.length,
      baseline: baseEstimate,
    });

    const downPaymentPercent = Number(
      this.clamp(
        aiEstimate?.downPaymentPercent ?? baseEstimate.downPaymentPercent,
        5,
        50,
      ).toFixed(1),
    );
    const interestRatePercent = Number(
      this.clamp(
        aiEstimate?.interestRatePercent ?? baseEstimate.interestRatePercent,
        2.5,
        15,
      ).toFixed(2),
    );
    const loanTermYears = Math.round(
      this.clamp(aiEstimate?.loanTermYears ?? baseEstimate.loanTermYears, 10, 40),
    );

    const mortgageMonthlyUsd = Number(
      this.calculateMonthlyMortgage(
        priceUsd,
        downPaymentPercent,
        interestRatePercent,
        loanTermYears,
      ).toFixed(0),
    );
    const insuranceMonthlyUsd = Number(
      this.clamp(
        aiEstimate?.insuranceMonthlyUsd ?? baseEstimate.insuranceMonthlyUsd,
        20,
        10000,
      ).toFixed(0),
    );
    const taxMonthlyUsd = Number(
      this.clamp(aiEstimate?.taxMonthlyUsd ?? baseEstimate.taxMonthlyUsd, 20, 15000).toFixed(
        0,
      ),
    );
    const totalMonthlyHousingCostUsd = Number(
      (mortgageMonthlyUsd + insuranceMonthlyUsd + taxMonthlyUsd).toFixed(0),
    );
    const missingCostsMonthlyUsd = Number(
      (insuranceMonthlyUsd + taxMonthlyUsd).toFixed(0),
    );

    const confidencePercent = Math.round(
      this.clamp(aiEstimate?.confidencePercent ?? baseEstimate.confidencePercent, 45, 95),
    );

    return {
      source: aiEstimate ? 'gemini-ai' : 'heuristic-fallback',
      asOfDate: new Date().toISOString(),
      property: {
        id: property.id,
        title: property.title,
        address: property.address,
        priceUsd,
      },
      mortgageMonthlyUsd,
      insuranceMonthlyUsd,
      taxMonthlyUsd,
      missingCostsMonthlyUsd,
      totalMonthlyHousingCostUsd,
      confidencePercent,
      financing: {
        downPaymentPercent,
        downPaymentUsd: Number(((priceUsd * downPaymentPercent) / 100).toFixed(0)),
        interestRatePercent,
        loanTermYears,
      },
      analysis:
        aiEstimate?.analysis ||
        'Estimated monthly housing cost is based on local lending assumptions and average ownership costs.',
      assumptions:
        aiEstimate?.assumptions?.length
          ? aiEstimate.assumptions
          : baseEstimate.assumptions,
    };
  }

  private async generateGeminiCostBreakdown(input: {
    propertyId: number;
    title: string;
    address: string;
    priceUsd: number;
    rooms: number;
    bathrooms: number;
    area: number;
    ratingAverage: number;
    ratingCount: number;
    wishlistCount: number;
    bookingCount: number;
    baseline: {
      downPaymentPercent: number;
      interestRatePercent: number;
      loanTermYears: number;
      mortgageMonthlyUsd: number;
      insuranceMonthlyUsd: number;
      taxMonthlyUsd: number;
      confidencePercent: number;
      assumptions: string[];
    };
  }): Promise<{
    downPaymentPercent: number;
    interestRatePercent: number;
    loanTermYears: number;
    insuranceMonthlyUsd: number;
    taxMonthlyUsd: number;
    confidencePercent: number;
    analysis: string;
    assumptions: string[];
  } | null> {
    if (!this.genAI) {
      return null;
    }

    const prompt = [
      'You are a real-estate mortgage advisor.',
      'Given the saved property data and baseline estimates, adjust assumptions for realistic monthly ownership costs.',
      'Return STRICT JSON only (no markdown, no code fence) with this schema:',
      '{',
      '  "downPaymentPercent": number,',
      '  "interestRatePercent": number,',
      '  "loanTermYears": number,',
      '  "insuranceMonthlyUsd": number,',
      '  "taxMonthlyUsd": number,',
      '  "confidencePercent": number,',
      '  "analysis": string,',
      '  "assumptions": string[]',
      '}',
      'Keep values realistic for today market and property context.',
      `Input data: ${JSON.stringify(input)}`,
    ].join('\n');

    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent(prompt);
      const parsed = this.tryParseJsonObject(result.response.text());

      if (!parsed) {
        return null;
      }

      const assumptions = Array.isArray(parsed.assumptions)
        ? parsed.assumptions
            .map((item: unknown) => String(item))
            .filter((item: string) => item.trim().length > 0)
            .slice(0, 5)
        : input.baseline.assumptions;

      return {
        downPaymentPercent: Number(parsed.downPaymentPercent),
        interestRatePercent: Number(parsed.interestRatePercent),
        loanTermYears: Number(parsed.loanTermYears),
        insuranceMonthlyUsd: Number(parsed.insuranceMonthlyUsd),
        taxMonthlyUsd: Number(parsed.taxMonthlyUsd),
        confidencePercent: Number(parsed.confidencePercent),
        analysis:
          typeof parsed.analysis === 'string'
            ? parsed.analysis
            : 'Gemini provided estimated ownership costs for this saved property.',
        assumptions,
      };
    } catch (error) {
      this.logger.warn(
        `Gemini property cost estimate failed; falling back to baseline. ${String(error)}`,
      );
      return null;
    }
  }

  private buildBaseCostEstimate(priceUsd: number) {
    const downPaymentPercent = 20;
    const interestRatePercent = priceUsd >= 700000 ? 6.6 : 6.9;
    const loanTermYears = 30;
    const mortgageMonthlyUsd = this.calculateMonthlyMortgage(
      priceUsd,
      downPaymentPercent,
      interestRatePercent,
      loanTermYears,
    );

    const insuranceMonthlyUsd = (priceUsd * 0.0045) / 12;
    const taxMonthlyUsd = (priceUsd * 0.012) / 12;

    return {
      downPaymentPercent,
      interestRatePercent,
      loanTermYears,
      mortgageMonthlyUsd,
      insuranceMonthlyUsd,
      taxMonthlyUsd,
      confidencePercent: 72,
      assumptions: [
        'Conventional fixed-rate mortgage with 20% down payment',
        'Estimated annual homeowners insurance at 0.45% of property value',
        'Estimated annual property tax at 1.2% of property value',
      ],
    };
  }

  private calculateMonthlyMortgage(
    priceUsd: number,
    downPaymentPercent: number,
    annualInterestRatePercent: number,
    loanTermYears: number,
  ) {
    const loanPrincipal = priceUsd * (1 - downPaymentPercent / 100);
    const monthlyRate = annualInterestRatePercent / 100 / 12;
    const months = loanTermYears * 12;

    if (monthlyRate <= 0) {
      return loanPrincipal / months;
    }

    const factor = Math.pow(1 + monthlyRate, months);
    return (loanPrincipal * monthlyRate * factor) / (factor - 1);
  }

  private tryParseJsonObject(text: string): Record<string, any> | null {
    const cleaned = text.trim();
    try {
      return JSON.parse(cleaned) as Record<string, any>;
    } catch {
      // Continue with substring parsing.
    }

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate) as Record<string, any>;
      } catch {
        return null;
      }
    }

    return null;
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
}
