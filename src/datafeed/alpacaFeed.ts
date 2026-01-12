/**
 * Alpaca Market Data Feed
 * Supports both IEX (free) and SIP (paid) feeds via WebSocket
 * Optional - bot works without it, but needed for real-time data
 */

import WebSocket, { type WebSocket as WS } from "ws";

export interface Bar {
  ts: number;           // Timestamp (milliseconds)
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AlpacaConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;     // Default: https://paper-api.alpaca.markets (paper) or https://api.alpaca.markets (live)
  feed?: "iex" | "sip"; // Default: "iex" (free), "sip" (paid)
}

export class AlpacaDataFeed {
  private config: AlpacaConfig;
  private ws: WS | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private barQueue: Bar[] = [];
  private resolveQueue: ((value: Bar) => void)[] = [];
  private reconnectBackoff: number = 5000; // Start with 5 seconds
  private maxBackoff: number = 60000; // Max 60 seconds

  constructor(config: AlpacaConfig) {
    this.config = {
      baseUrl: config.baseUrl || "https://paper-api.alpaca.markets",
      feed: config.feed || "iex",
      ...config
    };
  }

  /**
   * Get WebSocket URL for feed type
   */
  private getWebSocketUrl(): string {
    const feed = this.config.feed || "iex";
    return `wss://stream.data.alpaca.markets/v2/${feed}`;
  }

  /**
   * Subscribe to 1-minute bars for a symbol via WebSocket
   * Returns async iterator of bars (real-time)
   */
  async *subscribeBars(symbol: string): AsyncGenerator<Bar, void, unknown> {
    const wsUrl = this.getWebSocketUrl();
    
    while (true) {
      try {
        // Ensure previous connection is closed
        if (this.ws) {
          try {
            this.ws.removeAllListeners();
            this.ws.close();
          } catch (e) {
            // Ignore errors when closing
          }
          this.ws = null;
        }
        
        console.log(`[Alpaca] Connecting to WebSocket (attempt, backoff: ${this.reconnectBackoff}ms)...`);
        
        // Connect WebSocket
        await this.connectWebSocket();
        
        // Authenticate
        await this.authenticate();
        
        // Subscribe to bars
        await this.subscribeToBars(symbol);
        
        // Reset backoff on successful connection
        this.reconnectBackoff = 5000;
        console.log(`[Alpaca] Successfully connected and subscribed, starting bar processing...`);
        
        // Yield bars as they arrive
        while (this.isConnected) {
          try {
            const bar = await this.waitForBar();
            if (bar) {
              yield bar;
            }
          } catch (barError: any) {
            // If waitForBar throws an error, log it but continue the loop
            console.error("[Alpaca] Error waiting for bar:", barError.message);
            // If connection is still valid, continue; otherwise break to reconnect
            if (!this.isConnected) {
              break;
            }
          }
        }
      } catch (error: any) {
        const errorMsg = error.message || String(error);
        console.error("[Alpaca] WebSocket error in generator loop:", errorMsg);
        console.error("[Alpaca] Error stack:", error.stack);
        
        // Close connection properly
        this.isConnected = false;
        if (this.ws) {
          try {
            this.ws.removeAllListeners();
            this.ws.close();
          } catch (e) {
            // Ignore errors when closing
          }
          this.ws = null;
        }
        
        // Exponential backoff with special handling for connection limit errors
        if (errorMsg.toLowerCase().includes("connection limit") || 
            errorMsg.toLowerCase().includes("limit exceeded")) {
          // Longer backoff for connection limit errors (30 seconds minimum)
          this.reconnectBackoff = Math.max(30000, this.reconnectBackoff * 2);
          console.log(`[Alpaca] Connection limit hit, backing off for ${this.reconnectBackoff / 1000}s`);
        } else {
          // Exponential backoff for other errors
          this.reconnectBackoff = Math.min(this.reconnectBackoff * 1.5, this.maxBackoff);
        }
        
        console.log(`[Alpaca] Will reconnect in ${this.reconnectBackoff / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, this.reconnectBackoff));
        console.log(`[Alpaca] Retrying connection...`);
      }
    }
  }

  /**
   * Connect to Alpaca WebSocket
   */
  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.getWebSocketUrl();
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on("open", () => {
        console.log(`[Alpaca] WebSocket connected to ${this.config.feed?.toUpperCase()} feed`);
        this.isConnected = true;
        resolve();
      });
      
      this.ws.on("error", (error) => {
        console.error("[Alpaca] WebSocket error:", error);
        this.isConnected = false;
        reject(error);
      });
      
      this.ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        console.log(`[Alpaca] WebSocket closed (code: ${code}, reason: ${reasonStr || "none"})`);
        this.isConnected = false;
        // Don't trigger immediate reconnect here - let the outer loop handle it with backoff
      });
      
      this.ws.on("message", (data: Buffer | string) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleWebSocketMessage(message);
        } catch (error: any) {
          console.error("[Alpaca] Message parse error:", error);
        }
      });
    });
  }

  /**
   * Authenticate with Alpaca WebSocket
   */
  private async authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      
      const authMessage = {
        action: "auth",
        key: this.config.apiKey,
        secret: this.config.apiSecret
      };
      
      const timeout = setTimeout(() => {
        reject(new Error("Authentication timeout"));
      }, 5000);
      
      const messageHandler = (data: Buffer | string) => {
        try {
          const message = JSON.parse(data.toString());
          if (message[0]?.T === "success" && message[0]?.msg === "authenticated") {
            clearTimeout(timeout);
            this.ws?.off("message", messageHandler);
            console.log("[Alpaca] Authenticated successfully");
            resolve();
          } else if (message[0]?.T === "error") {
            clearTimeout(timeout);
            this.ws?.off("message", messageHandler);
            reject(new Error(message[0].msg || "Authentication failed"));
          }
        } catch (error) {
          // Not auth response, continue
        }
      };
      
      this.ws.on("message", messageHandler);
      this.ws.send(JSON.stringify(authMessage));
    });
  }

  /**
   * Subscribe to 1-minute bars for symbol
   */
  private async subscribeToBars(symbol: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    
    const subscribeMessage = {
      action: "subscribe",
      bars: [symbol]  // Subscribe to 1-minute bars
    };
    
    this.ws.send(JSON.stringify(subscribeMessage));
    console.log(`[Alpaca] Subscribed to bars for ${symbol}`);
  }

  /**
   * Handle WebSocket messages
   */
  private handleWebSocketMessage(message: any): void {
    // Alpaca v2 WebSocket format: array of messages
    if (Array.isArray(message)) {
      for (const msg of message) {
        if (msg.T === "b") {  // Bar message
          const bar: Bar = {
            ts: new Date(msg.t).getTime(),
            symbol: msg.S,
            open: msg.o,
            high: msg.h,
            low: msg.l,
            close: msg.c,
            volume: msg.v
          };
          
          // Yield to waiting iterator
          if (this.resolveQueue.length > 0) {
            const resolve = this.resolveQueue.shift()!;
            resolve(bar);
          } else {
            this.barQueue.push(bar);
          }
        }
      }
    }
  }

  /**
   * Wait for next bar (async)
   */
  private async waitForBar(): Promise<Bar | null> {
    return new Promise((resolve) => {
      if (this.barQueue.length > 0) {
        resolve(this.barQueue.shift()!);
        return;
      }
      
      this.resolveQueue.push(resolve);
      
      // Timeout after 60 seconds
      setTimeout(() => {
        const index = this.resolveQueue.indexOf(resolve);
        if (index > -1) {
          this.resolveQueue.splice(index, 1);
          resolve(null);
        }
      }, 60000);
    });
  }

  /**
   * Close WebSocket connection
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  /**
   * Get latest bar via REST API (polling fallback)
   */
  async getLatestBar(symbol: string): Promise<Bar | null> {
    try {
      const url = `${this.config.baseUrl}/v2/stocks/${symbol}/bars/latest`;
      const response = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": this.config.apiKey,
          "APCA-API-SECRET-KEY": this.config.apiSecret
        }
      });

      if (!response.ok) {
        throw new Error(`Alpaca API error: ${response.status}`);
      }

      const data = await response.json();
      const bar = data.bar;
      
      if (!bar) return null;

      return {
        ts: new Date(bar.t).getTime(),
        symbol,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v
      };
    } catch (error: any) {
      console.error("Alpaca API error:", error.message);
      return null;
    }
  }

  /**
   * Poll for new bars (1-minute interval)
   * Yields bars when new minute bar closes
   */
  async *pollBars(symbol: string, intervalMs: number = 60000): AsyncGenerator<Bar, void, unknown> {
    let lastBarTs: number | null = null;

    while (true) {
      const bar = await this.getLatestBar(symbol);
      
      if (bar && (!lastBarTs || bar.ts > lastBarTs)) {
        lastBarTs = bar.ts;
        yield bar;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}
