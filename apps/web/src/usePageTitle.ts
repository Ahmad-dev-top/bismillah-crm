import { useEffect } from "react";

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Bismillah CRM`;
    return () => {
      document.title = "Bismillah Internet CRM";
    };
  }, [title]);
}
