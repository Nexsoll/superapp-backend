import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { LocalizationService } from './localization.service';
import { TranslateTextDto } from './dto/translate-text.dto';

@Controller('localization')
export class LocalizationController {
  constructor(private readonly localizationService: LocalizationService) {}

  @Post('translate')
  async translateTexts(@Body() dto: TranslateTextDto) {
    return this.localizationService.translateTexts({
      texts: dto.texts,
      targetLanguage: dto.targetLanguage,
      sourceLanguage: dto.sourceLanguage,
    });
  }

  @Get('visitor-locale')
  async getVisitorLocale(@Req() request: Request) {
    return this.localizationService.resolveVisitorLocale(request);
  }
}
