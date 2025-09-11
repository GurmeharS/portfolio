export interface PortfolioConfig {
  sections: {
    hero: boolean;
    experience: boolean;
    projects: boolean;
    contact: boolean;
  };
  experience: {
    showNotesDemo: boolean;
  };
}

export const portfolioConfig: PortfolioConfig = {
  sections: {
    hero: true,
    experience: true,
    projects: false,
    contact: true,
  },
  experience: {
    showNotesDemo: false,
  },
};
