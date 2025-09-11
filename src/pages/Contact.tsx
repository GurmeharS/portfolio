const Contact = () => {
  return (
    <main className="contact-page min-h-screen bg-amber-50 overflow-hidden">
      <section className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-3xl font-bold mb-4">Get in touch</h1>
        <p className="text-muted-foreground mb-8">Email me at gurm.sand@gmail.com or reach out on LinkedIn.</p>
        <div className="flex justify-center gap-4">
          <a className="contact-ref text-sm" href="mailto:gurm.sand@gmail.com"><em>Email</em></a>
          <a className="contact-ref text-sm" href="linkedin.com/in/gurmehar-sandhu"><em>LinkedIn</em></a>
          <a className="contact-ref text-sm" href="https://github.com/GurmeharS"><em>GitHub</em></a>
        </div>
      </section>
    </main>
  );
};

export default Contact;


