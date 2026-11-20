require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

let botState = {
  isRunning: false,
  mode: "PAPER",
  pair: "EUR/USD",
  lotSize: 0.01,
  intervalSeconds: 60,
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  broker: "mt5",
  credentials: {},
  lastSignal: null,
  tradeLogs: [],
};

const SYMBOL_MAP = {
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
  "USD/JPY": "USDJPY=X",
  "USD/CHF": "USDCHF=X",
  "XAU/USD": "GC=F",
  "BTC/USD": "BTC-USD",
};

async function fetchLiveCandles(pair) {
  const yahooSymbol = SYMBOL_MAP[pair] || "EURUSD=X";
  const url = `https://yahoo.com{yahooSymbol}?interval=15m&range=1d`;

  const response = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const result = response.data.chart.result[0];
  const quotes = result.indicators.quote[0];
  const timestamps = result.timestamp;

  const candles = [];
  const startIdx = Math.max(0, timestamps.length - 15);
  for (let i = startIdx; i < timestamps.length; i++) {
    if (quotes.close[i] !== null) {
      candles.push({
        open: Number(quotes.open[i].toFixed(5)),
        high: Number(quotes.high[i].toFixed(5)),
        low: Number(quotes.low[i].toFixed(5)),
        close: Number(quotes.close[i].toFixed(5)),
      });
    }
  }
  return candles;
}

async function analyzeMarketWithGemini(pair, candles) {
  if (!botState.geminiApiKey) {
    throw new Error("Gemini API Key missing in bot configuration.");
  }

  const ai = new GoogleGenAI({ apiKey: botState.geminiApiKey });
  const currentPrice = candles[candles.length - 1].close;

  const prompt = `Analyze these recent 15m OHLC candles for ${pair} (Current Price: ${currentPrice}):
${JSON.stringify(candles)}

Respond ONLY in valid JSON format with no markdown:
{
  "signal": "BUY" | "SELL" | "WAIT",
  "confidence": 0-100,
  "entry": number,
  "sl": number,
  "tp": number,
  "reason": "short 1 sentence reason"
}
Only give BUY or SELL if confidence >= 78 and trend/momentum is clear; otherwise return WAIT.`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      systemInstruction:
        "You are an institutional quantitative forex trading algorithm. Return strictly valid JSON only.",
      responseMimeType: "application/json",
    },
  });

  return JSON.parse(response.text);
}

async function executeBrokerTrade(signalData) {
  const { broker, credentials, pair, lotSize, mode } = botState;

  if (mode === "PAPER") {
    return {
      status: "PAPER_EXECUTED",
      orderId: `PAPER-${Date.now()}`,
      details: `Virtual ${signalData.signal} ${lotSize} ${pair} @ ${signalData.entry}`,
    };
  }

  if (broker === "angelone") {
    const res = await axios.post(
      "https://angelbroking.com",
      {
        variety: "NORMAL",
        tradingsymbol: credentials.tradingSymbol || "USDINR26NOVFUT",
        symboltoken: credentials.symbolToken || "2845",
        transactiontype: signalData.signal,
        exchange: "CDS",
        ordertype: "MARKET",
        producttype: "INTRADAY",
        duration: "DAY",
        quantity: Math.round(lotSize * 100),
      },
      {
        headers: {
          Authorization: `Bearer ${credentials.jwtToken}`,
          "Content-Type": "application/json",
          "X-UserType": "USER",
          "X-SourceID": "WEB",
          "X-ClientLocalIP": "127.0.0.1",
          "X-ClientPublicIP": "127.0.0.1",
          "X-MACAddress": "00:00:00:00:00:00",
          "X-PrivateKey": credentials.apiKey,
        },
      }
    );
    return { status: "LIVE_ANGELONE", data: res.data };
  }

  if (broker === "dhan") {
    const res = await axios.post(
      "https://dhan.co",
      {
        dhanClientId: credentials.clientId,
        transactionType: signalData.signal,
        exchangeSegment: "NSE_CURRENCY",
        productType: "INTRADAY",
        orderType: "MARKET",
        validity: "DAY",
        securityId: credentials.securityId || "1001",
        quantity: Math.round(lotSize * 100),
      },
      {
        headers: {
          "access-token": credentials.apiKey,
          "Content-Type": "application/json",
        },
      }
    );
    return { status: "LIVE_DHAN", data: res.data };
  }

  if (broker === "mt5") {
    const actionType =
      signalData.signal === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
    const res = await axios.post(
      `https://agiliumtrade.ai{credentials.accountId}/trade`,
      {
        actionType,
        symbol: pair.replace("/", ""),
        volume: parseFloat(lotSize),
        stopLoss: parseFloat(signalData.sl),
        takeProfit: parseFloat(signalData.tp),
      },
      {
        headers: {
          "auth-token": credentials.apiKey,
          "Content-Type": "application/json",
        },
      }
    );
    return { status: "LIVE_MT5", data: res.data };
  }

  throw new Error("Unsupported broker configured.");
}

async function runTradingCycle() {
  if (!botState.isRunning) return;

  console.log(`[${new Date().toISOString()}] Scanning ${botState.pair}...`);
  try {
    const candles = await fetchLiveCandles(botState.pair);
    const aiResult = await analyzeMarketWithGemini(botState.pair, candles);

    botState.lastSignal = {
      ...aiResult,
      pair: botState.pair,
      timestamp: new Date().toISOString(),
    };

    if (
      (aiResult.signal === "BUY" || aiResult.signal === "SELL") &&
      aiResult.confidence >= 78
    ) {
      const execResult = await executeBrokerTrade(aiResult);
      botState.tradeLogs.unshift({
        time: new Date().toISOString(),
        pair: botState.pair,
        action: aiResult.signal,
        lotSize: botState.lotSize,
        entry: aiResult.entry,
        sl: aiResult.sl,
        tp: aiResult.tp,
        mode: botState.mode,
        execution: execResult,
      });
      if (botState.tradeLogs.length > 50) botState.tradeLogs.pop();
      console.log(`Trade Executed:`, execResult);
    }
  } catch (error) {
    console.error("24/7 Cycle Error:", error.message);
  }
}

setInterval(runTradingCycle, 60 * 1000);

app.get("/health", (req, res) => {
  res.json({
    status: "ONLINE_24_7",
    botRunning: botState.isRunning,
    mode: botState.mode,
    pair: botState.pair,
  });
});

app.post("/api/bot/start", (req, res) => {
  const { mode, pair, lotSize, geminiApiKey, broker, credentials } = req.body;
  botState = {
    ...botState,
    isRunning: true,
    mode: mode || botState.mode,
    pair: pair || botState.pair,
    lotSize: lotSize || botState.lotSize,
    geminiApiKey: geminiApiKey || botState.geminiApiKey,
    broker: broker || botState.broker,
    credentials: credentials || botState.credentials,
  };
  runTradingCycle();
  res.json({ success: true, message: "24/7 Auto-Trading Started", botState });
});

app.post("/api/bot/stop", (req, res) => {
  botState.isRunning = false;
  res.json({ success: true, message: "24/7 Auto-Trading Stopped" });
});

app.get("/api/bot/status", (req, res) => {
  res.json({
    isRunning: botState.isRunning,
    mode: botState.mode,
    pair: botState.pair,
    lotSize: botState.lotSize,
    lastSignal: botState.lastSignal,
    tradeLogs: botState.tradeLogs,
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`24/7 Forex AI Auto-Trading Server active on port ${PORT}`);
});
