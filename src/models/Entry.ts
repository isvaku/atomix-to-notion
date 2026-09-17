import { Document } from "mongoose";

export interface IEntry extends Document {
  entryId: string;
  title?: string;
  author?: string;
  summary?: string;
  content: string;
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
