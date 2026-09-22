import { Document } from "mongoose";

export interface IEntry extends Document {
  entryId: string;
  title?: string;
  author?: string;
  summary?: string;
  // Article HTML: gzipped since 1.6.0, plain string on older rows
  content?: string;
  contentGzip?: Buffer;
  // Size of the HTML before compression, kept for the storage stats
  contentBytes?: number;
  link: string;
  // Page exists in Notion
  created?: boolean;
  // Gave up syncing to Notion after all attempts; see entryErrors
  failed?: boolean;
  failedAt?: Date;
  entryErrors?: string[];
  entryDate: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
