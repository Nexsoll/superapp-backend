import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';

@Injectable()
export class MailerService {
  private transporter;

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT'),
      secure: this.configService.get<string>('SMTP_SECURE') === 'true', // upgrade later with STARTTLS
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async sendOtp(email: string, otp: string) {
    const mailOptions = {
      from: `"Super App Support" <${this.configService.get<string>('SMTP_USER')}>`,
      to: email,
      subject: 'Your OTP Code',
      text: `Your OTP code is ${otp}. It will expire in 10 minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Email Verification</h2>
          <p>Your OTP code is:</p>
          <h1 style="color: #4CAF50; letter-spacing: 5px;">${otp}</h1>
          <p>Please use this code to verify your account. It will expire in 10 minutes.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`OTP sent to ${email}`);
      return true;
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  }

  private async generateReceiptPDF(data: {
    bookingReference: string;
    bookingType: 'hotel' | 'property';
    listingTitle: string;
    location: string;
    checkIn: string;
    checkOut: string;
    guests?: number;
    rooms?: string[];
    totalAmount: string;
    paymentMethod: string;
  }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header with background color
      doc.rect(0, 0, doc.page.width, 100).fill('#2FC1BE');

      doc.fillColor('#FFFFFF')
         .fontSize(24)
         .font('Helvetica-Bold')
         .text('BOOKING RECEIPT', 50, 30);

      doc.fontSize(14)
         .font('Helvetica')
         .text('Super App', 50, 60);

      // Reset color
      doc.fillColor('#000000');

      // Booking Reference Box
      doc.moveDown(3);
      const refY = doc.y;
      doc.rect(50, refY, doc.page.width - 100, 50)
         .lineWidth(2)
         .strokeColor('#2FC1BE')
         .stroke();

      doc.fontSize(12)
         .font('Helvetica-Bold')
         .text('Booking Reference:', 60, refY + 15);

      doc.fontSize(16)
         .fillColor('#2FC1BE')
         .text(data.bookingReference, 300, refY + 15);

      doc.fillColor('#000000');

      // Booking Details Section
      doc.moveDown(3);
      doc.fontSize(16)
         .font('Helvetica-Bold')
         .text('Booking Details', 50, doc.y);

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(0.5);

      doc.fontSize(11).font('Helvetica');
      this.addDetailRow(doc, 'Property:', data.listingTitle);
      this.addDetailRow(doc, 'Location:', data.location);
      this.addDetailRow(doc, 'Type:', data.bookingType === 'hotel' ? 'Hotel Booking' : 'Property Purchase');

      if (data.rooms && data.rooms.length > 0) {
        this.addDetailRow(doc, 'Rooms:', data.rooms.join(', '));
      }

      // Stay Details Section
      doc.moveDown(1);
      doc.fontSize(16)
         .font('Helvetica-Bold')
         .text('Stay Details', 50, doc.y);

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(0.5);

      doc.fontSize(11).font('Helvetica');
      this.addDetailRow(doc, 'Check-in:', data.checkIn);
      this.addDetailRow(doc, 'Check-out:', data.checkOut);
      if (data.guests) {
        this.addDetailRow(doc, 'Guests:', data.guests.toString());
      }

      // Payment Details Section
      doc.moveDown(1);
      doc.fontSize(16)
         .font('Helvetica-Bold')
         .text('Payment Details', 50, doc.y);

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(0.5);

      doc.fontSize(11).font('Helvetica');
      this.addDetailRow(doc, 'Payment Method:', data.paymentMethod);

      // Total Box
      doc.moveDown(2);
      const totalY = doc.y;
      doc.rect(50, totalY, doc.page.width - 100, 50)
         .fillAndStroke('#E8F8F7', '#2FC1BE');

      doc.fillColor('#000000')
         .fontSize(14)
         .font('Helvetica-Bold')
         .text('Total Paid:', 60, totalY + 15);

      doc.fontSize(18)
         .fillColor('#2FC1BE')
         .text(data.totalAmount, 300, totalY + 15);

      // Footer
      doc.fillColor('#666666')
         .fontSize(10)
         .font('Helvetica')
         .text('Thank you for booking with Super App!', 50, doc.page.height - 80, {
           align: 'center',
           width: doc.page.width - 100,
         });

      doc.fontSize(8)
         .text(`Generated on ${new Date().toLocaleString()}`, 50, doc.page.height - 60, {
           align: 'center',
           width: doc.page.width - 100,
         });

      doc.end();
    });
  }

  private addDetailRow(doc: PDFKit.PDFDocument, label: string, value: string) {
    const y = doc.y;
    doc.text(label, 60, y, { continued: false });
    doc.font('Helvetica-Bold').text(value, 300, y);
    doc.font('Helvetica');
    doc.moveDown(0.5);
  }

  async sendBookingConfirmation(data: {
    email: string;
    bookingReference: string;
    bookingType: 'hotel' | 'property';
    listingTitle: string;
    location: string;
    checkIn: string;
    checkOut: string;
    guests?: number;
    rooms?: string[];
    totalAmount: string;
    paymentMethod: string;
  }) {
    const {
      email,
      bookingReference,
      bookingType,
      listingTitle,
      location,
      checkIn,
      checkOut,
      guests,
      rooms,
      totalAmount,
      paymentMethod,
    } = data;

    const roomsHtml = rooms && rooms.length > 0
      ? `<p><strong>Rooms:</strong> ${rooms.join(', ')}</p>`
      : '';

    const guestsHtml = guests
      ? `<p><strong>Guests:</strong> ${guests}</p>`
      : '';

    // Generate PDF receipt
    const pdfBuffer = await this.generateReceiptPDF(data);

    const mailOptions = {
      from: `"Super App Bookings" <${this.configService.get<string>('SMTP_USER')}>`,
      to: email,
      subject: `Booking Confirmation - ${bookingReference}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #2FC1BE 0%, #27B9B6 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
            .booking-ref { background: white; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0; border: 2px dashed #2FC1BE; }
            .booking-ref h2 { margin: 0; color: #2FC1BE; font-size: 24px; }
            .details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .details p { margin: 10px 0; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            .button { display: inline-block; padding: 12px 30px; background: #2FC1BE; color: white; text-decoration: none; border-radius: 8px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Booking Confirmed!</h1>
              <p>Your ${bookingType} reservation has been successfully completed</p>
            </div>
            <div class="content">
              <div class="booking-ref">
                <p style="margin: 0; color: #666; font-size: 14px;">Booking Reference</p>
                <h2>${bookingReference}</h2>
              </div>

              <div class="details">
                <h3 style="color: #2FC1BE; margin-top: 0;">${listingTitle}</h3>
                <p><strong>📍 Location:</strong> ${location}</p>
                <p><strong>📅 Check-in:</strong> ${checkIn}</p>
                <p><strong>📅 Check-out:</strong> ${checkOut}</p>
                ${guestsHtml}
                ${roomsHtml}
                <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
                <p><strong>💰 Total Paid:</strong> ${totalAmount}</p>
                <p><strong>💳 Payment Method:</strong> ${paymentMethod}</p>
              </div>

              <div style="text-align: center;">
                <p style="color: #666;">Please show your booking reference at check-in</p>
                <p style="color: #666;">Your receipt is attached to this email</p>
              </div>
            </div>
            <div class="footer">
              <p>Thank you for booking with Super App!</p>
              <p>If you have any questions, please contact our support team.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      attachments: [
        {
          filename: `receipt_${bookingReference}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`Booking confirmation sent to ${email}`);
      return true;
    } catch (error) {
      console.error('Error sending booking confirmation email:', error);
      throw error;
    }
  }
}
