"use client";

import { useEffect, useState } from "react";

// Default location — Bangkok. Used when the browser denies/lacks geolocation.
// Change these coords (or just rely on geolocation below) for another city.
const FALLBACK = { lat: 13.7563, lon: 100.5018, label: "Bangkok" };

// A small live clock + current temperature, meant to sit at the bottom of the
// sidebar. Temperature comes from Open-Meteo (free, no API key, CORS-enabled so
// it works straight from the browser); the clock ticks locally each second.
export default function TimeWeather() {
  const [now, setNow] = useState(() => new Date());
  const [weather, setWeather] = useState(null); // { temp, unit, label }
  const [err, setErr] = useState("");

  // Live clock — tick every second.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Temperature: fetch once, then refresh every 10 minutes.
  useEffect(() => {
    let cancelled = false;
    let intervalId;

    async function load({ lat, lon, label }) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`weather ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setWeather({
          temp: Math.round(data.current.temperature_2m),
          unit: data.current_units?.temperature_2m || "°C",
          label,
        });
        setErr("");
      } catch (_) {
        if (!cancelled) setErr("Weather unavailable");
      }
    }

    function start(coords) {
      load(coords);
      intervalId = setInterval(() => load(coords), 10 * 60 * 1000);
    }

    // Prefer the user's real location; fall back to Bangkok if denied/unavailable.
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => start({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Your location" }),
        () => start(FALLBACK),
        { timeout: 5000 }
      );
    } else {
      start(FALLBACK);
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

  return (
    <div className="time-weather">
      <div className="tw-time">🕒 {time}</div>
      <div className="tw-date muted">{date}</div>
      <div className="tw-temp">
        {weather
          ? `🌡️ ${weather.temp}${weather.unit} · ${weather.label}`
          : err || "Loading weather…"}
      </div>
    </div>
  );
}
