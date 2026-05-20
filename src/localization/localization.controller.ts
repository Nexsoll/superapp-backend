import { Body, Controller, Post } from '@nestjs/common';
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
}

