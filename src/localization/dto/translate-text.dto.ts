import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Length } from 'class-validator';

export class TranslateTextDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(128)
  @IsString({ each: true })
  texts!: string[];

  @IsString()
  @Length(2, 12)
  targetLanguage!: string;

  @IsOptional()
  @IsString()
  @Length(2, 12)
  sourceLanguage?: string;
}

