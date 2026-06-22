"use client";

import { useEffect, useRef } from "react";
import { API_URL } from "./api";

// Derive the WebSocket URL from the gateway HTTP URL: http->ws, https->wss.
function wsUrl() {
  const base = API_URL.replace(/^http/, "ws");
  return `${base}/ws`;
}

// Subscribe to live "product.stock.changed" pushes from the gateway.
// `onStockChange({ productId, stock })` is called for each event. The callback
// is kept in a ref so the socket isn't torn down every render when a caller
// passes an inline function. Auto-reconnects with a small backoff.
export function useStockSocket(onStockChange) {
  const cbRef = useRef(onStockChange);
  cbRef.current = onStockChange;

  useEffect(() => {
    let ws;
    let retry;
    let closed = false;

    function connect() {
      ws = new WebSocket(wsUrl());

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "product.stock.changed") {
            cbRef.current?.({ productId: msg.productId, stock: msg.stock });
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000); // reconnect
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
}
