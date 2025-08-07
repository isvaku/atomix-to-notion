import mongoose, { Schema } from "mongoose";
import { IEntry } from "./Entry";

const EntrySchema: Schema = new Schema(
  {
    entryId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    title: {
      type: String,
      required: false,
    },
    author: {
      type: String,
      required: false,
    },
    summary: {
      type: String,
      required: false,
    },
    content: {
      type: String,
      required: true,
    },
    link: {
      type: String,
      required: true,
      unique: true,
    },
    created: {
      type: Boolean,
      default: false,
    },
    entryErrors: {
      type: [String],
      default: [],
    },
    entryDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Create indexes for better query performance
EntrySchema.index({ entryDate: -1 });
EntrySchema.index({ created: 1 });

export default mongoose.model<IEntry>("Entry", EntrySchema);
