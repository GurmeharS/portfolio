import { useEffect } from "react";

export function useMusebookMetadata(title: string, description: string) {
  useEffect(() => {
    const previousTitle = document.title;
    const existing = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const meta = existing ?? document.createElement("meta");
    const previousDescription = meta.getAttribute("content");
    meta.name = "description";
    meta.content = description;
    if (!existing) document.head.appendChild(meta);
    document.title = title;

    return () => {
      document.title = previousTitle;
      if (!existing) meta.remove();
      else if (previousDescription === null) meta.removeAttribute("content");
      else meta.content = previousDescription;
    };
  }, [title, description]);
}
