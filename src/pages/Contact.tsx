const Contact = () => {
  return (
    <main className="contact-page min-h-screen bg-amber-50 overflow-hidden">
      <section className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-3xl font-bold mb-4">Get in touch</h1>
        <p className="text-muted-foreground mb-8">Email me at gurmehar@example.com or reach out on LinkedIn.</p>
        <div className="flex justify-center gap-4">
          <a className="underline" href="mailto:gurmehar@example.com">Email</a>
          <a className="underline" href="#">LinkedIn</a>
          <a className="underline" href="#">GitHub</a>
        </div>
      </section>
    </main>
  );
};

export default Contact;


