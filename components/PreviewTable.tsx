interface PreviewTableProps {
  data: Record<string, unknown>[];
  maxRows?: number;
}

export default function PreviewTable({
  data,
  maxRows = 200,
}: PreviewTableProps) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-base-content/50 py-4 text-center">
        No data to preview.
      </p>
    );
  }

  const headers = Object.keys(data[0]);
  const rows = data.slice(0, maxRows);
  const truncated = data.length > maxRows;

  return (
    <div>
      <div className="overflow-x-auto rounded border border-base-200">
        <table className="table table-xs table-zebra w-full">
          <thead>
            <tr>
              {headers.map((h) => (
                <th
                  key={h}
                  className="whitespace-nowrap font-semibold text-base-content"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {headers.map((h) => (
                  <td
                    key={h}
                    className="max-w-xs truncate"
                    title={String(row[h] ?? "")}
                  >
                    {String(row[h] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="text-xs text-base-content/50 mt-2 text-right">
          Showing first {maxRows} of {data.length} rows.
        </p>
      )}
    </div>
  );
}
