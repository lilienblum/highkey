export function PageLoading({ label = "Loading page" }: { label?: string }) {
  return (
    <p className="route-loading" role="status" aria-label={label}>
      {label}…
    </p>
  );
}
