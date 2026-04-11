import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenerativeAI,
  GenerativeModel,
  Content,
} from '@google/generative-ai';
import { SpeechClient } from '@google-cloud/speech';
import { BookingStatus, ListingType } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';

type InvestmentCandidate = {
  propertyId: number;
  title: string;
  address: string;
  priceUsd: number;
  listingType: ListingType;
  ratingAverage: number;
  ratingCount: number;
  wishlistCount: number;
  recentBookings: number;
  previousBookings: number;
  bookingMomentum: number;
  demandIndex: number;
  expectedRoiPercent: number;
  marketGrowthPercent: number;
  investmentChancePercent: number;
  estimatedProfit12MonthsUsd: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  marketSentiment: 'Bullish' | 'Positive' | 'Cautious';
  reasons: string[];
  score: number;
};

@Injectable()
export class AiAssistantService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private speechClient: SpeechClient;
  private readonly logger = new Logger(AiAssistantService.name);

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY') || '';
    this.genAI = new GoogleGenerativeAI(apiKey);

    // Define tools
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'getHotelRecommendations',
            description:
              'Get hotel or property recommendations based on location and price range.',
            parameters: {
              type: 'OBJECT',
              properties: {
                location: {
                  type: 'STRING',
                  description:
                    'The location to search for hotels (e.g., London, Paris).',
                },
                priceMin: {
                  type: 'NUMBER',
                  description: 'Minimum price per night.',
                },
                priceMax: {
                  type: 'NUMBER',
                  description: 'Maximum price per night.',
                },
                category: {
                  type: 'STRING',
                  description:
                    'Type of accommodation: "Hotel", "Property", or "All". Defaults to "All" if not specified.',
                  enum: ['Hotel', 'Property', 'All'],
                },
              },
              required: ['location'],
            },
          },
          {
            name: 'getPricePrediction',
            description:
              'Get price prediction chart data for a specific hotel.',
            parameters: {
              type: 'OBJECT',
              properties: {
                hotelName: {
                  type: 'STRING',
                  description: 'The name of the hotel.',
                },
              },
              required: ['hotelName'],
            },
          },
          {
            name: 'getStaffMembers',
            description: 'Get a list of staff members.',
            parameters: {
              type: 'OBJECT',
              properties: {},
            },
          },
          {
            name: 'getStaffCompletedJobs',
            description:
              'Get a list of completed jobs for a specific staff member.',
            parameters: {
              type: 'OBJECT',
              properties: {
                staffName: {
                  type: 'STRING',
                  description:
                    'The name of the staff member (first name or last name).',
                },
              },
              required: ['staffName'],
            },
          },
          {
            name: 'getAvailableJobs',
            description: 'Get a list of currently available (queued) jobs.',
            parameters: {
              type: 'OBJECT',
              properties: {},
            },
          },
        ],
      },
    ];

    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      tools: tools as any, // valid in newer SDK versions
    });

    this.speechClient = new SpeechClient();
  }

  private chatHistory = new Map<number, Content[]>();

  async transcribeAudio(input: { audioBuffer: Buffer; mimeType?: string }) {
    const mimeType = (input.mimeType || '').toLowerCase();

    // Debug logging
    this.logger.log(`Audio received: ${input.audioBuffer.length} bytes, mimeType: ${input.mimeType || 'none'}`);
    const header = input.audioBuffer.subarray(0, 12).toString('ascii');
    this.logger.log(`Audio header: ${JSON.stringify(header)}`);

    // For best results and simplest config we expect WAV/LINEAR16.
    // If you want MP3/M4A/OGG, we should convert to LINEAR16 on backend via ffmpeg.
    const looksLikeWav = header.startsWith('RIFF') && header.includes('WAVE');
    const isWav = mimeType.includes('wav') || looksLikeWav;
    if (!isWav) {
      throw new BadRequestException(
        'Unsupported audio type. Please upload WAV audio (audio/wav).',
      );
    }

    const audio = {
      content: input.audioBuffer.toString('base64'),
    };

    const config = {
      encoding: 'LINEAR16' as const,
      sampleRateHertz: 16000,
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
    };

    this.logger.log('Calling Google Speech API...');
    const [response] = await this.speechClient.recognize({
      audio,
      config,
    });

    this.logger.log(`Speech API response: ${JSON.stringify(response)}`);

    const transcript = (response.results || [])
      .map((r) => r.alternatives?.[0]?.transcript || '')
      .join(' ')
      .trim();

    this.logger.log(`Transcript: "${transcript}"`);

    return transcript;
  }

  async chat(userId: number, userMessage: string) {
    // Retrieve or initialize history
    let history = this.chatHistory.get(userId);
    if (!history) {
      history = [
        {
          role: 'user',
          parts: [{ text: 'Hello, I am a traveler.' }],
        },
        {
          role: 'model',
          parts: [
            {
              text: "Hello! I'm your AI travel assistant. How can I help you today?",
            },
          ],
        },
      ];
    }

    const chat = this.model.startChat({
      history: history,
    });

    let result = await chat.sendMessage(userMessage);
    let response = result.response;
    let functionCalls = response.functionCalls();

    const responseData = {
      messages: [] as any[],
    };

    // Loop to handle function calls and feed them back to the model
    while (functionCalls && functionCalls.length > 0) {
      const functionResponses: any[] = [];

      for (const call of functionCalls) {
        if (call.name === 'getHotelRecommendations') {
          const args = call.args as any;
          const category = args.category || 'All';
          console.log(`Calling getHotelRecommendations with:`, args);

          const hotels = await this.getHotels(
            args.location,
            category,
            args.priceMin,
            args.priceMax,
          );

          // Add structured data for Frontend
          let typeText = 'hotel and property';
          if (category === 'Hotel') typeText = 'hotel';
          if (category === 'Property') typeText = 'property';

          if (hotels.length > 0) {
            responseData.messages.push({
              type: 'text',
              content: `Here are some ${typeText} recommendations in ${args.location}.`,
            });
            responseData.messages.push({
              type: 'hotel_list',
              data: hotels,
            });
          } else {
            responseData.messages.push({
              type: 'text',
              content: `I'm sorry, I couldn't find any ${typeText} in ${args.location} within that price range.`,
            });
          }

          // Prepare response for the Model
          functionResponses.push({
            functionResponse: {
              name: 'getHotelRecommendations',
              response: { hotels: hotels }, // Pass the data to the model!
            },
          });
        } else if (call.name === 'getPricePrediction') {
          const args = call.args as any;
          console.log(`Calling getPricePrediction for:`, args.hotelName);

          const chartData = await this.getPricePrediction(args.hotelName);

          responseData.messages.push({
            type: 'text',
            content: `Here is the price trend for ${args.hotelName}.`,
          });
          responseData.messages.push({
            type: 'chart',
            data: chartData,
          });

          functionResponses.push({
            functionResponse: {
              name: 'getPricePrediction',
              response: { prediction: chartData },
            },
          });
        } else if (call.name === 'getStaffMembers') {
          console.log(`Calling getStaffMembers`);
          const staff = await this.getStaffMembers();
          functionResponses.push({
            functionResponse: {
              name: 'getStaffMembers',
              response: { staff },
            },
          });
        } else if (call.name === 'getStaffCompletedJobs') {
          const args = call.args as any;
          console.log(`Calling getStaffCompletedJobs for:`, args.staffName);
          const jobs = await this.getStaffCompletedJobs(args.staffName);
          functionResponses.push({
            functionResponse: {
              name: 'getStaffCompletedJobs',
              response: { jobs },
            },
          });
        } else if (call.name === 'getAvailableJobs') {
          console.log(`Calling getAvailableJobs`);
          const jobs = await this.getAvailableJobs();
          functionResponses.push({
            functionResponse: {
              name: 'getAvailableJobs',
              response: { jobs },
            },
          });
        }
      }

      // Send function responses back to the model
      if (functionResponses.length > 0) {
        result = await chat.sendMessage(functionResponses);
        response = result.response;
        functionCalls = response.functionCalls();
      } else {
        break; // Should not happen if functionCalls > 0
      }
    }

    // Add the final text response from the model (after it processed the function data)
    const text = response.text();
    if (text) {
      responseData.messages.push({
        type: 'text',
        content: text,
      });
    }

    // Save updated history
    this.chatHistory.set(userId, await chat.getHistory());

    return responseData;
  }

  // --- Helper Functions ---

  private async getHotels(
    location: string,
    category: string,
    min?: number,
    max?: number,
  ) {
    const whereHotel: any = {};
    const whereProperty: any = {};

    if (location) {
      whereHotel.address = { contains: location, mode: 'insensitive' };
      whereProperty.address = { contains: location, mode: 'insensitive' };
    }

    let mappedHotels: any[] = [];
    let mappedProperties: any[] = [];

    if (category === 'Hotel' || category === 'All') {
      const hotels = await this.prisma.hotel.findMany({
        where: whereHotel,
        include: {
          rooms: true,
          reviews: true,
        },
        take: 5,
      });
      mappedHotels = hotels.map((h) => {
        const lowestPrice =
          h.rooms.length > 0
            ? Math.min(...h.rooms.map((r) => Number(r.price)))
            : 0;
        const hotelImages = h.images && h.images.length > 0 ? h.images : [];
        return {
          id: h.id,
          name: h.title,
          location: h.address,
          price: lowestPrice,
          image: hotelImages.length > 0 ? hotelImages[0] : null,
          match: '95% Match',
          type: 'Hotel',
          title: h.title,
          address: h.address,
          description: h.description,
          images: hotelImages,
          amenities: h.amenities,
          rooms: h.rooms,
          reviews: h.reviews,
          latitude: h.latitude,
          longitude: h.longitude,
        };
      });
    }

    if (category === 'Property' || category === 'All') {
      const properties = await this.prisma.property.findMany({
        where: whereProperty,
        include: {
          reviews: true,
        },
        take: 5,
      });
      mappedProperties = properties.map((p) => {
        const propertyImages = p.images && p.images.length > 0 ? p.images : [];
        return {
          id: p.id,
          name: p.title,
          location: p.address,
          price: Number(p.price),
          image: propertyImages.length > 0 ? propertyImages[0] : null,
          match: '90% Match',
          type: 'Property',
          title: p.title,
          address: p.address,
          description: p.description,
          images: propertyImages,
          amenities: p.amenities,
          neighborhoodInsights: (p as any).neighborhoodInsights || [],
          rooms: p.rooms,
          bathrooms: p.bathrooms,
          area: p.area,
          reviews: p.reviews,
          latitude: p.latitude,
          longitude: p.longitude,
        };
      });
    }

    const allResults = [...mappedHotels, ...mappedProperties];

    // Filter by price
    return allResults.filter((h) => {
      if (min && h.price < min) return false;
      if (max && h.price > max) return false;
      return true;
    });
  }

  private async getPricePrediction(hotelName: string) {
    // Mock data for chart
    return {
      currentPrice: 200,
      bestPrice: 260,
      confidence: 87,
      points: [
        { x: 0, y: 220 },
        { x: 1, y: 210 },
        { x: 2, y: 240 },
        { x: 3, y: 180 }, // Low point
        { x: 4, y: 190 },
        { x: 5, y: 200 },
      ],
      xLabels: ['Jan 15', 'Jan 22', 'Jan 29', 'Feb 5', 'Feb 12', 'Feb 19'],
    };
  }

  private async getStaffMembers() {
    const staff = await this.prisma.user.findMany({
      where: { role: 'STAFF' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        fullName: true,
        email: true,
        avatar: true,
      },
    });
    return staff;
  }

  private async getStaffCompletedJobs(staffName: string) {
    const jobs = await this.prisma.job.findMany({
      where: {
        status: { in: ['COMPLETED', 'APPROVED'] },
        assignments: {
          some: {
            applier: {
              OR: [
                { firstName: { contains: staffName, mode: 'insensitive' } },
                { lastName: { contains: staffName, mode: 'insensitive' } },
                { fullName: { contains: staffName, mode: 'insensitive' } },
              ],
            },
          },
        },
      },
      include: {
        property: { select: { title: true } },
        hotel: { select: { title: true } },
      },
    });
    return jobs;
  }

  private async getAvailableJobs() {
    const jobs = await this.prisma.job.findMany({
      where: { status: 'QUEUED' },
      include: {
        property: { select: { title: true } },
        hotel: { select: { title: true } },
      },
    });
    return jobs;
  }

  async getRandomRecommendations(type?: string) {
    const category = type || 'All';
    const hotels = await this.getHotels('', category);

    const shuffled = [...hotels].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 6);

    return {
      count: selected.length,
      recommendations: selected,
    };
  }

  async getInvestmentAnnouncement(userId?: number) {
    const baseWhere: any = {
      isActive: true,
      listingType: ListingType.FOR_SALE,
    };

    if (typeof userId === 'number') {
      baseWhere.ownerId = { not: userId };
    }

    let properties = await this.prisma.property.findMany({
      where: baseWhere,
      include: {
        reviews: {
          select: {
            rating: true,
          },
        },
        wishlists: {
          select: {
            id: true,
          },
        },
        bookings: {
          where: {
            status: {
              in: [
                BookingStatus.PENDING,
                BookingStatus.ACTIVE,
                BookingStatus.COMPLETED,
              ],
            },
          },
          select: {
            status: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 50,
    });

    if (!properties.length && typeof userId === 'number') {
      properties = await this.prisma.property.findMany({
        where: {
          isActive: true,
          listingType: ListingType.FOR_SALE,
        },
        include: {
          reviews: {
            select: {
              rating: true,
            },
          },
          wishlists: {
            select: {
              id: true,
            },
          },
          bookings: {
            where: {
              status: {
                in: [
                  BookingStatus.PENDING,
                  BookingStatus.ACTIVE,
                  BookingStatus.COMPLETED,
                ],
              },
            },
            select: {
              status: true,
              createdAt: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 50,
      });
    }

    const asOfDate = new Date();

    if (!properties.length) {
      return {
        source: 'no-data',
        asOfDate: asOfDate.toISOString(),
        announcement: {
          title: 'Property for Investment',
          description:
            'No active investment properties are available right now. Please check again later.',
          buttonText: 'Explore Properties',
        },
        recommendation: null,
      };
    }

    const candidates = properties
      .map((property) => this.toInvestmentCandidate(property as any, asOfDate))
      .filter((candidate) => candidate.priceUsd > 0)
      .sort((a, b) => b.score - a.score);

    const bestCandidate = candidates[0];
    const topCandidates = candidates.slice(0, 5);

    const geminiOutput = await this.generateInvestmentAnnouncementWithGemini(
      topCandidates,
      asOfDate,
    );

    if (geminiOutput) {
      const selectedCandidate =
        topCandidates.find((c) => c.propertyId === geminiOutput.propertyId) ||
        bestCandidate;

      return this.composeInvestmentAnnouncement(selectedCandidate, asOfDate, {
        source: 'gemini-ai',
        headline: geminiOutput.headline,
        marketSummary: geminiOutput.marketSummary,
        chancePercent: geminiOutput.investmentChancePercent,
        expectedRoiPercent: geminiOutput.expectedRoiPercent,
        estimatedProfit12MonthsUsd: geminiOutput.estimatedProfit12MonthsUsd,
        rationale: geminiOutput.rationale,
        riskLevel: geminiOutput.riskLevel,
        ctaText: geminiOutput.ctaText,
      });
    }

    return this.composeInvestmentAnnouncement(bestCandidate, asOfDate, {
      source: 'heuristic-fallback',
    });
  }

  private composeInvestmentAnnouncement(
    candidate: InvestmentCandidate,
    asOfDate: Date,
    ai?: {
      source: 'gemini-ai' | 'heuristic-fallback';
      headline?: string;
      marketSummary?: string;
      chancePercent?: number;
      expectedRoiPercent?: number;
      estimatedProfit12MonthsUsd?: number;
      rationale?: string[];
      riskLevel?: 'Low' | 'Medium' | 'High';
      ctaText?: string;
    },
  ) {
    const chancePercent = Math.round(
      this.clamp(
        ai?.chancePercent ?? candidate.investmentChancePercent,
        1,
        99,
      ),
    );
    const expectedRoiPercent = Number(
      this.clamp(
        ai?.expectedRoiPercent ?? candidate.expectedRoiPercent,
        1,
        35,
      ).toFixed(1),
    );
    const estimatedProfit12MonthsUsd = Number(
      Math.max(
        ai?.estimatedProfit12MonthsUsd ??
          candidate.estimatedProfit12MonthsUsd,
        0,
      ).toFixed(0),
    );
    const riskLevel = ai?.riskLevel ?? candidate.riskLevel;
    const rationale =
      ai?.rationale && ai.rationale.length > 0
        ? ai.rationale.slice(0, 3)
        : candidate.reasons;

    const headline = ai?.headline?.trim();
    const ctaText = ai?.ctaText?.trim();
    const marketSummary = ai?.marketSummary?.trim();

    return {
      source: ai?.source ?? 'heuristic-fallback',
      asOfDate: asOfDate.toISOString(),
      announcement: {
        title: headline && headline.length > 0 ? headline : 'Property for Investment',
        description:
          `Buy "${candidate.title}" for investment. ` +
          `Today market chance: ${chancePercent}%. ` +
          `Estimated 12-month profit: $${estimatedProfit12MonthsUsd} ` +
          `(${expectedRoiPercent}% ROI).`,
        buttonText: ctaText && ctaText.length > 0 ? ctaText : 'View Investment',
      },
      recommendation: {
        propertyId: candidate.propertyId,
        propertyTitle: candidate.title,
        address: candidate.address,
        priceUsd: candidate.priceUsd,
        investmentChancePercent: chancePercent,
        expectedRoiPercent,
        estimatedProfit12MonthsUsd,
        riskLevel,
        marketSentiment: candidate.marketSentiment,
        marketSummary:
          marketSummary && marketSummary.length > 0
            ? marketSummary
            : `Demand index ${candidate.demandIndex}/100 with ${candidate.recentBookings} recent bookings and ${candidate.wishlistCount} wishlists.`,
        rationale,
      },
    };
  }

  private async generateInvestmentAnnouncementWithGemini(
    candidates: InvestmentCandidate[],
    asOfDate: Date,
  ): Promise<{
    propertyId: number;
    headline: string;
    marketSummary: string;
    investmentChancePercent: number;
    expectedRoiPercent: number;
    estimatedProfit12MonthsUsd: number;
    rationale: string[];
    riskLevel: 'Low' | 'Medium' | 'High';
    ctaText: string;
  } | null> {
    if (!candidates.length) {
      return null;
    }

    const apiKey = this.configService.get<string>('GEMINI_API_KEY') || '';
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY missing. Using heuristic fallback.');
      return null;
    }

    const payload = candidates.map((candidate) => ({
      propertyId: candidate.propertyId,
      title: candidate.title,
      address: candidate.address,
      priceUsd: candidate.priceUsd,
      listingType: candidate.listingType,
      ratingAverage: candidate.ratingAverage,
      ratingCount: candidate.ratingCount,
      wishlistCount: candidate.wishlistCount,
      recentBookings: candidate.recentBookings,
      previousBookings: candidate.previousBookings,
      demandIndex: candidate.demandIndex,
      expectedRoiPercent: candidate.expectedRoiPercent,
      marketGrowthPercent: candidate.marketGrowthPercent,
      investmentChancePercent: candidate.investmentChancePercent,
      estimatedProfit12MonthsUsd: candidate.estimatedProfit12MonthsUsd,
      riskLevel: candidate.riskLevel,
      marketSentiment: candidate.marketSentiment,
      reasons: candidate.reasons,
    }));

    const prompt = [
      'You are a real-estate investment analyst.',
      `Today is ${asOfDate.toISOString().split('T')[0]}.`,
      'Based only on the candidate data below, pick ONE property to recommend for investment today.',
      'Return STRICT JSON only (no markdown, no code fences) with this schema:',
      '{',
      '  "propertyId": number,',
      '  "headline": string,',
      '  "marketSummary": string,',
      '  "investmentChancePercent": number,',
      '  "expectedRoiPercent": number,',
      '  "estimatedProfit12MonthsUsd": number,',
      '  "rationale": string[],',
      '  "riskLevel": "Low" | "Medium" | "High",',
      '  "ctaText": string',
      '}',
      'Keep numbers realistic and grounded in candidate metrics.',
      `Candidates: ${JSON.stringify(payload)}`,
    ].join('\n');

    try {
      const model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = this.tryParseJsonObject(text);

      if (!parsed) {
        return null;
      }

      const selectedPropertyId = Number(parsed.propertyId);
      const selectedCandidate =
        candidates.find((c) => c.propertyId === selectedPropertyId) ||
        candidates[0];

      const rationale = Array.isArray(parsed.rationale)
        ? parsed.rationale
            .map((item: unknown) => String(item))
            .filter((item: string) => item.trim().length > 0)
            .slice(0, 3)
        : selectedCandidate.reasons;

      return {
        propertyId: selectedCandidate.propertyId,
        headline:
          typeof parsed.headline === 'string'
            ? parsed.headline
            : 'Property for Investment',
        marketSummary:
          typeof parsed.marketSummary === 'string'
            ? parsed.marketSummary
            : `Demand index ${selectedCandidate.demandIndex}/100 and positive booking momentum.`,
        investmentChancePercent: Number(
          this.clamp(
            Number(parsed.investmentChancePercent) ||
              selectedCandidate.investmentChancePercent,
            1,
            99,
          ).toFixed(0),
        ),
        expectedRoiPercent: Number(
          this.clamp(
            Number(parsed.expectedRoiPercent) ||
              selectedCandidate.expectedRoiPercent,
            1,
            35,
          ).toFixed(1),
        ),
        estimatedProfit12MonthsUsd: Number(
          Math.max(
            Number(parsed.estimatedProfit12MonthsUsd) ||
              selectedCandidate.estimatedProfit12MonthsUsd,
            0,
          ).toFixed(0),
        ),
        rationale,
        riskLevel: this.normalizeRiskLevel(
          typeof parsed.riskLevel === 'string'
            ? parsed.riskLevel
            : selectedCandidate.riskLevel,
        ),
        ctaText:
          typeof parsed.ctaText === 'string' && parsed.ctaText.trim().length > 0
            ? parsed.ctaText
            : 'View Investment',
      };
    } catch (error) {
      this.logger.warn(
        `Gemini investment announcement failed. Using heuristic fallback. ${String(error)}`,
      );
      return null;
    }
  }

  private normalizeRiskLevel(value: string): 'Low' | 'Medium' | 'High' {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'low') return 'Low';
    if (normalized === 'high') return 'High';
    return 'Medium';
  }

  private toInvestmentCandidate(property: any, asOfDate: Date): InvestmentCandidate {
    const nowMs = asOfDate.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const last90Start = nowMs - 90 * dayMs;
    const previous90Start = nowMs - 180 * dayMs;

    const priceUsd = Number(property.price || 0);
    const ratingValues: number[] = (property.reviews || []).map((r: any) =>
      Number(r.rating || 0),
    );
    const ratingCount = ratingValues.length;
    const ratingAverage =
      ratingCount > 0
        ? ratingValues.reduce((sum, value) => sum + value, 0) / ratingCount
        : 0;

    const wishlistCount = Array.isArray(property.wishlists)
      ? property.wishlists.length
      : 0;

    const bookings = Array.isArray(property.bookings) ? property.bookings : [];
    const recentBookings = bookings.filter((booking: any) => {
      const bookingMs = new Date(booking.createdAt).getTime();
      return bookingMs >= last90Start;
    }).length;
    const previousBookings = bookings.filter((booking: any) => {
      const bookingMs = new Date(booking.createdAt).getTime();
      return bookingMs >= previous90Start && bookingMs < last90Start;
    }).length;

    const bookingMomentum =
      previousBookings > 0
        ? (recentBookings - previousBookings) / previousBookings
        : recentBookings > 0
          ? 0.6
          : 0;

    const neighborhoodSignal = Array.isArray(property.neighborhoodInsights)
      ? property.neighborhoodInsights.length
      : 0;

    const demandIndex = Number(
      this.clamp(
        25 +
          recentBookings * 8 +
          wishlistCount * 3 +
          ratingAverage * 9 +
          bookingMomentum * 12 +
          neighborhoodSignal * 2,
        10,
        99,
      ).toFixed(0),
    );

    const expectedRoiPercent = Number(
      this.clamp(
        4 +
          ratingAverage * 0.9 +
          recentBookings * 0.7 +
          wishlistCount * 0.35 +
          bookingMomentum * 2.8 +
          neighborhoodSignal * 0.25,
        3.5,
        22,
      ).toFixed(1),
    );

    const marketGrowthPercent = Number(
      this.clamp(
        1.5 +
          bookingMomentum * 5 +
          recentBookings * 0.5 +
          ratingAverage * 0.5 +
          neighborhoodSignal * 0.2,
        1,
        20,
      ).toFixed(1),
    );

    const investmentChancePercent = Number(
      this.clamp(
        35 +
          demandIndex * 0.45 +
          expectedRoiPercent * 1.3 +
          marketGrowthPercent * 0.8,
        35,
        97,
      ).toFixed(0),
    );

    const estimatedProfit12MonthsUsd = Number(
      (priceUsd * ((expectedRoiPercent + marketGrowthPercent) / 100)).toFixed(
        0,
      ),
    );

    const riskLevel: 'Low' | 'Medium' | 'High' =
      investmentChancePercent >= 80
        ? 'Low'
        : investmentChancePercent >= 65
          ? 'Medium'
          : 'High';

    const marketSentiment: 'Bullish' | 'Positive' | 'Cautious' =
      investmentChancePercent >= 80
        ? 'Bullish'
        : investmentChancePercent >= 65
          ? 'Positive'
          : 'Cautious';

    const momentumPercent = Number((bookingMomentum * 100).toFixed(0));
    const momentumLabel = `${momentumPercent >= 0 ? '+' : ''}${momentumPercent}%`;

    const reasons = [
      `Demand index ${demandIndex}/100 with ${wishlistCount} wishlists`,
      `Booking momentum ${momentumLabel} in the last 90 days`,
      `Projected combined return ${(
        expectedRoiPercent + marketGrowthPercent
      ).toFixed(1)}% over 12 months`,
    ];

    return {
      propertyId: Number(property.id),
      title: String(property.title || 'Property'),
      address: String(property.address || 'Prime location'),
      priceUsd,
      listingType: property.listingType as ListingType,
      ratingAverage: Number(ratingAverage.toFixed(2)),
      ratingCount,
      wishlistCount,
      recentBookings,
      previousBookings,
      bookingMomentum: Number(bookingMomentum.toFixed(2)),
      demandIndex,
      expectedRoiPercent,
      marketGrowthPercent,
      investmentChancePercent,
      estimatedProfit12MonthsUsd,
      riskLevel,
      marketSentiment,
      reasons,
      score:
        investmentChancePercent +
        expectedRoiPercent * 2 +
        marketGrowthPercent * 1.5 +
        ratingAverage * 2,
    };
  }

  private tryParseJsonObject(text: string): Record<string, any> | null {
    const cleaned = text.trim();

    try {
      return JSON.parse(cleaned) as Record<string, any>;
    } catch {
      // ignore and try extracting a JSON object body
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
    return Math.min(max, Math.max(min, value));
  }
}
