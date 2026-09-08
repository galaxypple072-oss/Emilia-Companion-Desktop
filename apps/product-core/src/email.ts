import nodemailer from "nodemailer";

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  bossEmail: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export function isValidEmailAddress(value: string): boolean {
  return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu.test(value)
    && !/[\r\n,;]/u.test(value);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when email is enabled`);
  return value;
}

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig | null {
  if (env.EMAIL_ENABLED?.trim().toLowerCase() !== "true") return null;
  const port = Number(env.SMTP_PORT ?? "465");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT is invalid");
  const secure = env.SMTP_SECURE?.trim().toLowerCase() !== "false";
  const bossEmail = required(env, "BOSS_EMAIL");
  if (!isValidEmailAddress(bossEmail)) throw new Error("BOSS_EMAIL is invalid");
  return {
    host: required(env, "SMTP_HOST"),
    port,
    secure,
    user: required(env, "SMTP_USER"),
    password: required(env, "SMTP_PASSWORD"),
    from: env.EMAIL_FROM?.trim() || required(env, "SMTP_USER"),
    bossEmail,
  };
}

export class SmtpEmailSender implements EmailSender {
  private readonly config: EmailConfig;
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;

  constructor(config: EmailConfig) {
    this.config = config;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const to = message.to.trim();
    const subject = message.subject.trim();
    const body = message.body.trim();
    if (!subject || !body) throw new Error("邮件主题和正文不能为空");
    if (!isValidEmailAddress(to)) throw new Error("收件邮箱格式不正确");
    if (subject.length > 200) throw new Error("邮件主题不能超过 200 字");
    if (body.length > 20_000) throw new Error("邮件正文不能超过 20000 字");
    const result = await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject,
      text: body,
    });
    return { messageId: result.messageId };
  }
}

export interface ParsedEmailInstruction {
  recipient: string;
  subject: string;
  body: string;
}

export function parseEmailInstruction(text: string): ParsedEmailInstruction | null {
  const normalized = text.trim();
  const command = /^\/email\s+(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+)$/iu.exec(normalized);
  if (command) return { recipient: command[1], subject: command[2], body: command[3] };
  const legacyCommand = /^\/email\s+(.+?)\s*\|\s*([\s\S]+)$/iu.exec(normalized);
  if (legacyCommand) return { recipient: "老板", subject: legacyCommand[1], body: legacyCommand[2] };

  const natural = /(?:给|向)\s*([^，,；;\n]+?)\s*发(?:一封|封|个)?邮件/iu.exec(normalized);
  if (!natural) return null;
  const subject = /主题(?:是|为)?\s*[：:]?\s*([^\n，,；;]+?)(?=\s*(?:，|,|；|;|\n|正文|内容))/iu.exec(normalized)?.[1];
  const body = /(?:正文|内容)(?:是|为)?\s*[：:]?\s*([\s\S]+)$/iu.exec(normalized)?.[1];
  if (!subject || !body) {
    throw new Error("请同时写明主题和内容，例如：给张三发邮件，主题：项目进度，内容：今天已完成联调。");
  }
  return { recipient: natural[1].trim(), subject, body };
}
