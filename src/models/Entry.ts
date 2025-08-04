import { Document } from "mongoose";

export interface IEntry extends Document {
  entryId: string;
  title?: string;
  author?: string;
  summary?: string;
  content: string;
  link: string;
  created?: boolean;
  entryErrors?: string[];
  entryDate: Date;
}
