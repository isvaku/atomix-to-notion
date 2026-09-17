import mongoose from "mongoose";
import { config } from "../config";
import { logger } from "../utils/logger";

class Database {
  private static instance: Database;
  private isConnected: boolean = false;
  private listenersAttached: boolean = false;

  public static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  public async connect(): Promise<void> {
    if (this.isConnected) {
      logger.debug("Database already connected");
      return;
    }

    if (!config.database.uri) {
      throw new Error("MONGODB_URI is not set");
    }

    try {
      await mongoose.connect(config.database.uri, config.database.options);
      this.isConnected = true;
      logger.info("Successfully connected to MongoDB");

      // Shutdown is handled by the application; only track connection state here
      if (!this.listenersAttached) {
        this.listenersAttached = true;

        mongoose.connection.on("error", (error) => {
          logger.error("MongoDB connection error:", error);
        });

        mongoose.connection.on("disconnected", () => {
          logger.warn("MongoDB disconnected");
          this.isConnected = false;
        });

        mongoose.connection.on("reconnected", () => {
          logger.info("MongoDB reconnected");
          this.isConnected = true;
        });
      }
    } catch (error) {
      logger.error("Failed to connect to MongoDB:", error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await mongoose.disconnect();
      this.isConnected = false;
      logger.info("Disconnected from MongoDB");
    } catch (error) {
      logger.error("Error disconnecting from MongoDB:", error);
      throw error;
    }
  }

  public isConnectedToDb(): boolean {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  public getConnection() {
    return mongoose.connection;
  }
}

export const database = Database.getInstance();
