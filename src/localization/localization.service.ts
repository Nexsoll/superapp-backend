import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';

type TranslationApiResponse = {
  data?: {
    translations?: Array<{
      translatedText?: string;
    }>;
  };
};

@Injectable()
export class LocalizationService {
  private readonly logger = new Logger(LocalizationService.name);
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-translation'],
  });

  async translateTexts(params: {
    texts: string[];
    targetLanguage: string;
    sourceLanguage?: string;
  }) {
    const normalizedTarget = params.targetLanguage.trim().toLowerCase();
    const normalizedSource = (params.sourceLanguage ?? 'en').trim().toLowerCase();

    if (!normalizedTarget) {
      throw new BadRequestException('Target language is required');
    }

    const inputs = params.texts.map((text) => text?.toString() ?? '');
    if (inputs.length === 0) {
      return {
        targetLanguage: normalizedTarget,
        sourceLanguage: normalizedSource,
        translations: [] as string[],
      };
    }

    if (normalizedTarget === normalizedSource) {
      return {
        targetLanguage: normalizedTarget,
        sourceLanguage: normalizedSource,
        translations: inputs,
      };
    }

    try {
      const client = await this.googleAuth.getClient();
      const token = await client.getAccessToken();
      const accessToken = token.token;

      if (!accessToken) {
        throw new BadRequestException('Google translation token is unavailable');
      }

      const response = await fetch(
        'https://translation.googleapis.com/language/translate/v2',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            q: inputs,
            target: normalizedTarget,
            source: normalizedSource,
            format: 'text',
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        this.logger.error(`Google Translate error: ${response.status} ${body}`);
        throw new BadRequestException('Failed to translate text');
      }

      const body = (await response.json()) as TranslationApiResponse;
      const translated = (body.data?.translations ?? []).map((item) =>
        (item.translatedText ?? '').toString(),
      );

      if (translated.length !== inputs.length) {
        this.logger.warn(
          `Translation count mismatch: expected ${inputs.length}, got ${translated.length}`,
        );
        return {
          targetLanguage: normalizedTarget,
          sourceLanguage: normalizedSource,
          translations: inputs,
        };
      }

      return {
        targetLanguage: normalizedTarget,
        sourceLanguage: normalizedSource,
        translations: translated,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(`Translation failed: ${error}`);
      throw new BadRequestException('Translation service is unavailable');
    }
  }
}
