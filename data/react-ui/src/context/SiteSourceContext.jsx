import { createContext, useCallback, useContext, useMemo, useState } from "react";

const SiteSourceContext = createContext(null);

export function SiteSourceProvider({ children }) {
  const [activeSiteId, setActiveSiteId] = useState(null);
  const [activeSiteName, setActiveSiteName] = useState(null);

  const setActiveSite = useCallback((siteId, siteName) => {
    if (!siteId) {
      setActiveSiteId(null);
      setActiveSiteName(null);
      return;
    }
    setActiveSiteId(siteId);
    setActiveSiteName(siteName || siteId);
  }, []);

  const clearActiveSite = useCallback(() => {
    setActiveSiteId(null);
    setActiveSiteName(null);
  }, []);

  const value = useMemo(
    () => ({
      activeSiteId,
      activeSiteName,
      isRemoteSource: Boolean(activeSiteId),
      setActiveSite,
      clearActiveSite,
    }),
    [activeSiteId, activeSiteName, setActiveSite, clearActiveSite]
  );

  return <SiteSourceContext.Provider value={value}>{children}</SiteSourceContext.Provider>;
}

export function useSiteSource() {
  const ctx = useContext(SiteSourceContext);
  if (!ctx) {
    throw new Error("useSiteSource must be used within a SiteSourceProvider");
  }
  return ctx;
}
