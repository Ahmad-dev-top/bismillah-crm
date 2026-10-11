export function BrandLogo({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="Bismillah Super Storm Fiber"
      className={`rounded-2xl object-cover shadow-[0_8px_20px_-8px_rgb(26_140_255_/_0.9)] ${className}`}
    />
  );
}
