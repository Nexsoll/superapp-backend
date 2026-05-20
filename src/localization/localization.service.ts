import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { GoogleAuth } from 'google-auth-library';

type TranslationApiResponse = {
  data?: {
    translations?: Array<{
      translatedText?: string;
    }>;
  };
};

type GeoResult = {
  source: string;
  ip?: string;
  countryCode?: string;
  countryName?: string;
  currencyCode?: string;
  languageCode?: string;
};

type CountryMetadata = {
  countryCode: string;
  countryName: string;
  currencyCode?: string;
  currencyName?: string;
  currencySymbol?: string;
  languageCode?: string;
  languageName?: string;
};

const iso639ThreeToGoogle: Record<string, string> = {
  afr: 'af',
  amh: 'am',
  ara: 'ar',
  aym: 'ay',
  aze: 'az',
  bel: 'be',
  ben: 'bn',
  bis: 'bi',
  bos: 'bs',
  bul: 'bg',
  cat: 'ca',
  ces: 'cs',
  ckb: 'ckb',
  dan: 'da',
  deu: 'de',
  div: 'dv',
  ell: 'el',
  eng: 'en',
  est: 'et',
  fas: 'fa',
  fin: 'fi',
  fra: 'fr',
  gle: 'ga',
  glv: 'gv',
  grn: 'gn',
  hat: 'ht',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  hye: 'hy',
  ind: 'id',
  isl: 'is',
  ita: 'it',
  jpn: 'ja',
  kal: 'kl',
  kat: 'ka',
  kaz: 'kk',
  khm: 'km',
  kir: 'ky',
  kor: 'ko',
  lao: 'lo',
  lat: 'la',
  lav: 'lv',
  lit: 'lt',
  ltz: 'lb',
  mah: 'mh',
  mkd: 'mk',
  mlg: 'mg',
  mlt: 'mt',
  mon: 'mn',
  msa: 'ms',
  mya: 'my',
  nau: 'na',
  nep: 'ne',
  nld: 'nl',
  nor: 'no',
  nya: 'ny',
  pap: 'pap',
  pol: 'pl',
  por: 'pt',
  pus: 'ps',
  que: 'qu',
  rar: 'rar',
  ron: 'ro',
  run: 'rn',
  rus: 'ru',
  sag: 'sg',
  sin: 'si',
  slk: 'sk',
  slv: 'sl',
  smo: 'sm',
  sna: 'sn',
  som: 'so',
  sot: 'st',
  spa: 'es',
  sqi: 'sq',
  srp: 'sr',
  swa: 'sw',
  swe: 'sv',
  tam: 'ta',
  tet: 'tet',
  tgk: 'tg',
  tha: 'th',
  tir: 'ti',
  ton: 'to',
  tpi: 'tpi',
  tuk: 'tk',
  tur: 'tr',
  tvl: 'tvl',
  ukr: 'uk',
  urd: 'ur',
  uzb: 'uz',
  vie: 'vi',
  xho: 'xh',
  zdj: 'zdj',
  zho: 'zh',
  zul: 'zu',
};

@Injectable()
export class LocalizationService {
  private readonly logger = new Logger(LocalizationService.name);
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-translation'],
  });

  async resolveVisitorLocale(request: Request) {
    const ip = this.extractClientIp(request);
    const headerCountryCode = this.extractCountryCodeFromHeaders(request);
    const preferredLanguage = this.extractPreferredLanguage(request);
    let geo: GeoResult | null = null;

    if (headerCountryCode) {
      geo = {
        source: 'edge-country-header',
        countryCode: headerCountryCode,
      };
    } else if (ip) {
      geo = await this.resolveGeoFromProviders(ip);
    }

    if (!geo?.countryCode) {
      return {
        countryCode: '',
        countryName: '',
        currencyCode: '',
        currencyName: '',
        currencySymbol: '',
        languageCode: '',
        languageName: '',
        source: 'unresolved',
      };
    }

    const preferredNonEnglish = preferredLanguage && preferredLanguage !== 'en'
      ? preferredLanguage
      : '';
    const metadata = await this.resolveCountryMetadata(geo.countryCode, {
      ...geo,
      languageCode: geo.languageCode || preferredNonEnglish,
    });

    return {
      ...metadata,
      ip: geo.ip || ip || '',
      source: geo.source,
    };
  }

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

    const cloudTranslations = await this.translateWithGoogleCloud(
      inputs,
      normalizedTarget,
      normalizedSource,
    );
    if (cloudTranslations.length === inputs.length) {
      return {
        targetLanguage: normalizedTarget,
        sourceLanguage: normalizedSource,
        translations: cloudTranslations,
      };
    }

    const publicTranslations = await this.translateWithGooglePublic(
      inputs,
      normalizedTarget,
      normalizedSource,
    );

    return {
      targetLanguage: normalizedTarget,
      sourceLanguage: normalizedSource,
      translations: publicTranslations,
    };
  }

  private async translateWithGoogleCloud(
    inputs: string[],
    targetLanguage: string,
    sourceLanguage: string,
  ) {
    try {
      const client = await this.googleAuth.getClient();
      const token = await client.getAccessToken();
      const accessToken = token.token;

      if (!accessToken) {
        this.logger.warn('Google translation token is unavailable');
        return [];
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
            target: targetLanguage,
            source: sourceLanguage,
            format: 'text',
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        this.logger.warn(`Google Translate cloud error: ${response.status} ${body}`);
        return [];
      }

      const body = (await response.json()) as TranslationApiResponse;
      return (body.data?.translations ?? []).map((item) =>
        (item.translatedText ?? '').toString(),
      );
    } catch (error) {
      this.logger.warn(`Google Translate cloud unavailable: ${error}`);
      return [];
    }
  }

  private async translateWithGooglePublic(
    inputs: string[],
    targetLanguage: string,
    sourceLanguage: string,
  ) {
    const translations: string[] = [];

    for (const input of inputs) {
      try {
        const url = new URL('https://translate.googleapis.com/translate_a/single');
        url.searchParams.set('client', 'gtx');
        url.searchParams.set('sl', sourceLanguage);
        url.searchParams.set('tl', targetLanguage);
        url.searchParams.set('dt', 't');
        url.searchParams.set('q', input);

        const response = await fetch(url);
        if (!response.ok) {
          translations.push(input);
          continue;
        }

        const decoded = (await response.json()) as unknown;
        translations.push(this.extractPublicTranslation(decoded) || input);
      } catch (error) {
        this.logger.warn(`Google Translate public fallback failed: ${error}`);
        translations.push(input);
      }
    }

    return translations;
  }

  private extractPublicTranslation(decoded: unknown) {
    if (!Array.isArray(decoded) || !Array.isArray(decoded[0])) return '';

    return decoded[0]
      .filter((segment): segment is unknown[] => Array.isArray(segment))
      .map((segment) => String(segment[0] ?? ''))
      .join('')
      .trim();
  }

  private extractClientIp(request: Request) {
    const headerCandidates = [
      request.headers['cf-connecting-ip'],
      request.headers['x-real-ip'],
      request.headers['x-forwarded-for'],
      request.ip,
      request.socket?.remoteAddress,
    ];

    for (const candidate of headerCandidates) {
      const raw = Array.isArray(candidate) ? candidate[0] : candidate;
      const ip = this.cleanIp(raw?.split(',')[0]);
      if (ip && !this.isPrivateIp(ip)) {
        return ip;
      }
    }

    return '';
  }

  private extractCountryCodeFromHeaders(request: Request) {
    const headerCandidates = [
      request.headers['cf-ipcountry'],
      request.headers['x-vercel-ip-country'],
      request.headers['x-country-code'],
      request.headers['cloudfront-viewer-country'],
      request.headers['x-appengine-country'],
    ];

    for (const candidate of headerCandidates) {
      const raw = Array.isArray(candidate) ? candidate[0] : candidate;
      const code = raw?.trim().toUpperCase() || '';
      if (!/^[A-Z]{2}$/.test(code)) continue;
      if (code === 'XX' || code === 'ZZ' || code === 'T1') continue;
      return code;
    }

    return '';
  }

  private extractPreferredLanguage(request: Request) {
    const header = request.headers['accept-language'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) return '';

    const first = raw
      .split(',')
      .map((part) => part.split(';')[0]?.trim() || '')
      .find(Boolean);

    return this.normalizeLanguageCode(first);
  }

  private cleanIp(ip?: string) {
    if (!ip) return '';
    return ip.trim().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  }

  private isPrivateIp(ip: string) {
    return (
      ip === '::1' ||
      ip === '127.0.0.1' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
      /^fc|^fd/i.test(ip)
    );
  }

  private async resolveGeoFromProviders(ip: string): Promise<GeoResult | null> {
    if (!ip) return null;

    const encodedIp = encodeURIComponent(ip);
    const providers = [
      () => this.geoFromIpWho(encodedIp),
      () => this.geoFromIpApi(encodedIp),
      () => this.geoFromIpApiCo(encodedIp),
      () => this.geoFromIpInfo(encodedIp),
    ];

    for (const provider of providers) {
      try {
        const result = await provider();
        if (result?.countryCode) return result;
      } catch (error) {
        this.logger.warn(`Geo provider failed: ${error}`);
      }
    }

    return null;
  }

  private async geoFromIpWho(encodedIp: string): Promise<GeoResult | null> {
    const data = await this.fetchJson(
      `https://ipwho.is/${encodedIp}`,
    ) as Record<string, any>;
    if (data?.success === false) return null;

    return {
      source: 'ipwho.is',
      ip: data?.ip?.toString(),
      countryCode: data?.country_code?.toString(),
      countryName: data?.country?.toString(),
      currencyCode: data?.currency?.code?.toString(),
      languageCode: this.normalizeLanguageCode(data?.languages?.[0]?.code),
    };
  }

  private async geoFromIpApi(encodedIp: string): Promise<GeoResult | null> {
    const path = encodedIp ? `/${encodedIp}` : '';
    const data = await this.fetchJson(
      `http://ip-api.com/json${path}?fields=status,message,query,country,countryCode,currency`,
    ) as Record<string, any>;
    if (data?.status !== 'success') return null;

    return {
      source: 'ip-api.com',
      ip: data?.query?.toString(),
      countryCode: data?.countryCode?.toString(),
      countryName: data?.country?.toString(),
      currencyCode: data?.currency?.toString(),
    };
  }

  private async geoFromIpApiCo(encodedIp: string): Promise<GeoResult | null> {
    const path = encodedIp ? `/${encodedIp}/json/` : '/json/';
    const data = await this.fetchJson(
      `https://ipapi.co${path}`,
    ) as Record<string, any>;
    if (data?.error) return null;

    return {
      source: 'ipapi.co',
      ip: data?.ip?.toString(),
      countryCode: data?.country_code?.toString(),
      countryName: data?.country_name?.toString(),
      currencyCode: data?.currency?.toString(),
      languageCode: this.firstLanguage(data?.languages?.toString()),
    };
  }

  private async geoFromIpInfo(encodedIp: string): Promise<GeoResult | null> {
    const path = encodedIp ? `/${encodedIp}` : '';
    const data = await this.fetchJson(
      `https://ipinfo.io${path}/json`,
    ) as Record<string, any>;

    return {
      source: 'ipinfo.io',
      ip: data?.ip?.toString(),
      countryCode: data?.country?.toString(),
      countryName: data?.country?.toString(),
    };
  }

  private async resolveCountryMetadata(
    countryCode: string,
    geo: GeoResult,
  ): Promise<CountryMetadata> {
    const code = countryCode.trim().toUpperCase();
    const data = await this.fetchJson(
      `https://restcountries.com/v3.1/alpha/${encodeURIComponent(code)}?fields=name,cca2,currencies,languages`,
    ) as any;
    const country = Array.isArray(data) ? data[0] : data;
    const currencies = country?.currencies ?? {};
    const currencyCode =
      geo.currencyCode?.trim().toUpperCase() ||
      Object.keys(currencies)[0]?.toUpperCase() ||
      '';
    const currency = currencyCode ? currencies[currencyCode] : undefined;
    const languages = country?.languages ?? {};
    const languageEntries = Object.entries(languages) as Array<[string, unknown]>;
    const languageCandidates = languageEntries
      .map(([key, value]) => ({
        code: this.normalizeLanguageCode(iso639ThreeToGoogle[key] || key),
        name: value?.toString() || '',
      }))
      .filter((entry) => Boolean(entry.code));
    const preferredGeoLanguage = this.normalizeLanguageCode(geo.languageCode);
    const preferredCandidate =
      preferredGeoLanguage && preferredGeoLanguage !== 'en'
        ? languageCandidates.find((entry) => entry.code === preferredGeoLanguage) || {
            code: preferredGeoLanguage,
            name: '',
          }
        : null;
    const countryPreferredCandidate =
      languageCandidates.find((entry) => entry.code !== 'en') ||
      languageCandidates[0] ||
      null;
    const chosenLanguage = preferredCandidate || countryPreferredCandidate;
    const countryLanguageCode =
      chosenLanguage?.code || 'en';
    const countryLanguageName =
      chosenLanguage?.name || countryLanguageCode;

    return {
      countryCode: code,
      countryName:
        country?.name?.common?.toString() ||
        geo.countryName ||
        code,
      currencyCode,
      currencyName: currency?.name?.toString() || '',
      currencySymbol: currency?.symbol?.toString() || currencyCode,
      languageCode: countryLanguageCode,
      languageName: countryLanguageName,
    };
  }

  private firstLanguage(raw?: string) {
    if (!raw) return '';
    const first = raw.split(',').map((item) => item.trim()).find(Boolean);
    return this.normalizeLanguageCode(first);
  }

  private normalizeLanguageCode(raw?: string) {
    const value = raw?.trim().toLowerCase() || '';
    if (!value) return '';

    const primary = value.split('-')[0];
    if (!primary) return '';

    if (primary.length === 3 && iso639ThreeToGoogle[primary]) {
      return iso639ThreeToGoogle[primary];
    }

    if (!/^[a-z]{2,3}$/.test(primary)) return '';
    return primary;
  }

  private async fetchJson(url: string, timeoutMs = 3500) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ids-europe-localization/1.0',
        },
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
