import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as admin from 'firebase-admin';
import { ServiceAccount } from 'firebase-admin';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  logger.log('⏳ Starting application...');

  // Auto-sync database schema on every startup using `db push`.
  // Using --accept-data-loss ensures the process never hangs waiting for user input
  // in Cloud Run, which causes the 'failed to listen on port' error.
  if (process.env.DATABASE_URL) {
    try {
      const migrateCmd = 'npx prisma db push --accept-data-loss --skip-generate';
      logger.log(`🔄 Syncing database schema (db push)...`);
      execSync(migrateCmd, { stdio: 'inherit' });
      logger.log('✅ Database schema is up to date');
    } catch (e) {
      logger.warn(`⚠️ Schema sync warning: ${e}`);
    }
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle('Super App API')
    .setDescription('The backend API for the Super App')
    .setVersion('1.0')
    .addBearerAuth() // Adds the "Authorize" button for JWT tokens
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const firebaseKeyPath = path.join(
    process.cwd(),
    'firebase-service-account.json',
  );

  if (fs.existsSync(firebaseKeyPath)) {
    const fileContent = fs.readFileSync(firebaseKeyPath, 'utf8');
    const adminConfig = JSON.parse(fileContent) as ServiceAccount;

    admin.initializeApp({
      credential: admin.credential.cert(adminConfig),
    });
    logger.log('✅ Firebase Admin initialized');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const adminConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
      admin.initializeApp({
        credential: admin.credential.cert(adminConfig),
      });
      logger.log('✅ Firebase Admin initialized (from env var)');
    } catch (e) {
      logger.error(`❌ Firebase Admin init failed from env var: ${e}`);
    }
  } else {
    try {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      logger.log('✅ Firebase Admin initialized (application default)');
    } catch (e) {
      logger.error(`❌ Firebase Admin init failed: ${e}`);
    }
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`🚀 Server ready at http://localhost:${port}`);
  logger.log(`📝 Swagger Docs available at http://localhost:${port}/api`);
}
bootstrap().catch((err) => {
  console.error('❌ Error starting server:', err);
  process.exit(1);
});
