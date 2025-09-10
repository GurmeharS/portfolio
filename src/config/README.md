# Portfolio Configuration

This directory contains configuration files for the portfolio website.

## portfolio.ts

The main configuration file that controls which sections of the portfolio are displayed.

### Usage

```typescript
import { portfolioConfig } from '@/config/portfolio';

// Check if a section should be displayed
if (portfolioConfig.sections.hero) {
  // Show hero section
}
```

### Configuration Options

#### Sections
- `hero`: Controls the main hero section with name, photo, and intro
- `experience`: Controls the experience/work history section
- `projects`: Controls the projects showcase section
- `contact`: Controls the "Let's Connect" contact section

#### Experience-specific Options
- `showNotesDemo`: Controls whether the Notes demo is shown within the "Instagram Sharing" experience item

### Example

To hide the projects section and disable the Notes demo:

```typescript
export const portfolioConfig: PortfolioConfig = {
  sections: {
    hero: true,
    experience: true,
    projects: false,  // Hide projects section
    contact: true,
  },
  experience: {
    showNotesDemo: false,  // Hide Notes demo
  },
};
```
