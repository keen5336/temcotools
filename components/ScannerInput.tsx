"use client";

import { useState } from "react";

export default function ScannerInput() {
  const [value, setValue] = useState("");

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-4">Scan Input</h2>
      <input
        type="text"
        placeholder="Scan or enter barcode..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
        autoFocus
      />
      <div className="border border-gray-200 rounded-lg p-4">
        <p className="text-sm text-gray-400">
          Scan results will appear here.
        </p>
      </div>
    </div>
  );
}
