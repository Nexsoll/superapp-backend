import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { MessagesModule } from './messages/messages.module';
import { PrismaModule } from 'prisma/prisma.module';
import { AiAssistantModule } from './ai-assistant/ai-assistant.module';
import { ListingModule } from './listings/listings.module';
import { StorageModule } from './storage/storage.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { ReviewModule } from './review/review.module';
import { ForumModule } from './forum/forum.module';
import { AdminModule } from './admin/admin.module';
import { ExpensesModule } from './expenses/expenses.module';
import { StaffModule } from './staff/staff.module';
import { IoTModule } from './iot/iot.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    MessagesModule,
    AiAssistantModule,
    ListingModule,
    StorageModule,
    WishlistModule,
    ReviewModule,
    ForumModule,
    AdminModule,
    ExpensesModule,
    StaffModule,
    IoTModule,
    NotificationsModule,
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }

