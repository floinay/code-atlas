import nodemailer from 'nodemailer';

const transport = nodemailer.createTransport({ url: process.env.SMTP_URL });

export async function sendMail(to: string, subject: string, text: string) {
  await transport.sendMail({ from: 'taskboard@example.com', to, subject, text });
}
