"use client";

import { useState } from "react";

export default function ScannerInput() {
  const [value, setValue] = useState("");

  return (
    <div className="bg-base-100 border border-base-200 rounded-lg p-6">
      <h2 className="text-base font-semibold text-base-content mb-4">Scan Input</h2>
      <input
        type="text"
        placeholder="Scan or enter barcode..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="input input-bordered input-sm w-full mb-4"
        autoFocus
      />
      <div className="border border-base-200 rounded-lg p-4">
        <p className="text-sm text-base-content/50">
          Scan results will appear here.
        </p>
      </div>
    </div>
  );
}
