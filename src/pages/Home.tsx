import { useState, useEffect } from 'react';

const useTypingAnimation = (texts: string[], typingSpeed: number = 100, deletingSpeed: number = 75, pauseTime: number = 4000) => {
  const [currentTextIndex, setCurrentTextIndex] = useState(0);
  const [currentText, setCurrentText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (texts.length === 0) return;
    
    const timeout = setTimeout(() => {
      if (isPaused) {
        setIsPaused(false);
        const nextTextIndex = (currentTextIndex + 1) % texts.length;
        const nextFullText = texts[nextTextIndex];
        
        // Check if current text is a prefix of next text
        if (nextFullText.startsWith(currentText)) {
          // Just add characters, don't delete
          setIsDeleting(false);
          setCurrentTextIndex(nextTextIndex);
        } else {
          // Need to delete characters
          setIsDeleting(true);
        }
        return;
      }

      const currentFullText = texts[currentTextIndex];
      const nextTextIndex = (currentTextIndex + 1) % texts.length;
      const nextFullText = texts[nextTextIndex];
      
      if (!isDeleting) {
        // Typing
        if (currentText.length < currentFullText.length) {
          setCurrentText(currentFullText.substring(0, currentText.length + 1));
        } else {
          // Finished typing current text, pause then transition to next
          setIsPaused(true);
        }
      } else {
        // Deleting
        if (currentText.length > 0) {
          // Check if we can stop deleting (current text becomes prefix of next)
          const potentialText = currentText.substring(0, currentText.length - 1);
          if (nextFullText.startsWith(potentialText)) {
            // Stop deleting and switch to typing
            setCurrentText(potentialText);
            setIsDeleting(false);
            setCurrentTextIndex(nextTextIndex);
          } else {
            // Continue deleting
            setCurrentText(potentialText);
          }
        } else {
          // Finished deleting, move to next text
          setIsDeleting(false);
          setCurrentTextIndex(nextTextIndex);
        }
      }
    }, isPaused ? pauseTime : (isDeleting ? deletingSpeed : typingSpeed));

    return () => clearTimeout(timeout);
  }, [currentText, isDeleting, isPaused, currentTextIndex, texts, typingSpeed, deletingSpeed, pauseTime]);

  return currentText;
};

const Home = () => {
  const [texts, setTexts] = useState(['gurmehar sandhu', 'gurm']);
  
  useEffect(() => {
    // 30% chance to add "Goat 🐐" to the texts array
    if (Math.random() < 0.30) {
      setTexts(['gurmehar sandhu', 'gurm', 'goat']);
    }
  }, []);

  const animatedText = useTypingAnimation(texts);

  return (
    <main className="home min-h-screen flex items-center justify-start bg-amber-50 overflow-hidden">
      <section className="text-left px-6 -mt-14 pb-20">
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
          {animatedText}
          <span className="animate-pulse">|</span>
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground max-w-2xl">
          currently enjoying building features that connect billions of people worldwide. 
        </p>
      </section>
    </main>
  );
};

export default Home;


