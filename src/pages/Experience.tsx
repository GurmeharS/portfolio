import Notes from '@/components/InstagramNotes';
import { portfolioConfig } from '@/config/portfolio';

const experiences = [
  {
    title: 'Instagram Friends',
    company: 'Meta',
    period: '2024 - Present',
    description:
      'Working on IG+ (consumer subscription) — new premium features for closer friends. Working on enabling and improving server support for IG Notes and other narrow-casting Friends features',
    featured: true,
    showDemo: portfolioConfig.experience.showNotesDemo,
  },
  {
    title: 'Instagram Integrity',
    company: 'Meta',
    period: '2023 - 2024',
    description:
      'keeping IG safe (comments, links, compliance, and more)',
  },
  {
    title: 'VR Identity',
    company: 'Meta',
    period: '2022 - 2023',
    description:
      'Enabling U13 accounts, parental controls, and more',
  },
];

const Experience = () => {

  return (
    <main className="experience-page min-h-screen bg-amber-50 overflow-hidden">
      <section className="text-left px-6 py-20">
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">experience</h1>
        
        <div className="max-w-4xl space-y-8 mb-12">
          {experiences.map((exp, idx) => (
            <div key={idx} className="experience-item pb-1">
              <h2 className="text-2xl font-semibold mb-2">{exp.title.toLowerCase()}</h2>
              <p className="text-lg text-muted-foreground mb-4">{exp.company.toLowerCase()} • {exp.period.toLowerCase()}</p>
              <p className="text-base text-muted-foreground mb-4">{exp.description.toLowerCase()}</p>
              {exp.featured && exp.showDemo && (
                <div className="mt-2">
                  <h3 className="text-lg font-semibold mb-4">demo</h3>
                  <div className="rounded-2xl border border-gray-200 shadow-sm">
                    <Notes />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
};

export default Experience;
