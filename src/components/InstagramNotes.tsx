import { useEffect, useState } from 'react';
import profileImage from '@/assets/gurmehar-profile.png';

interface Note {
  id: string;
  username: string;
  message: string;
  avatar: string;
  isOnline?: boolean;
}

const mockNotes: Note[] = [
  {
    id: '1',
    username: 'gurm',
    message: 'sup',
    avatar: profileImage,
    isOnline: true
  },
  {
    id: '2',
    username: 'Alex Chen',
    message: 'Working on new React features! 💻',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
    isOnline: true
  },
  {
    id: '3',
    username: 'Sarah Kim',
    message: 'Coffee break anyone? ☕️',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
    isOnline: false
  },
  {
    id: '4',
    username: 'Marcus Johnson',
    message: 'Finally shipped that feature! 🚀',
    avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face',
    isOnline: true
  },
  {
    id: '5',
    username: 'Emily Davis',
    message: 'Design review at 3pm 🎨',
    avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&h=150&fit=crop&crop=face',
    isOnline: false
  },
  {
    id: '6',
    username: 'David Wilson',
    message: 'Weekend hackathon prep! 💪',
    avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&h=150&fit=crop&crop=face',
    isOnline: true
  }
];

// Custom hook to calculate text height
const useTextHeight = (text: string, maxWidth: number = 240) => {
  const [height, setHeight] = useState(0);
  
  useEffect(() => {
    // Create a temporary element to measure text height
    const tempElement = document.createElement('p');
    tempElement.className = 'text-xs text-foreground text-center font-medium leading-tight'
    tempElement.style.position = 'absolute';
    tempElement.style.visibility = 'hidden';
    tempElement.style.height = 'auto';
    tempElement.style.width = `${maxWidth}px`;
    tempElement.style.fontSize = '0.75rem';
    tempElement.style.fontWeight = '500';
    tempElement.style.lineHeight = '1.25';
    tempElement.style.padding = '8px 12px';
    tempElement.style.fontFamily = 'inherit';
    tempElement.style.textAlign  = 'center';
    tempElement.style.display = 'block';
    tempElement.style.marginBlockStart = '1em';
    tempElement.style.marginBlockEnd = '1em';
    tempElement.style.marginInlineStart = '0px';
    tempElement.style.marginInlineEnd = '0px';
    tempElement.style.unicodeBidi = 'isolate';
    tempElement.textContent = text;
    
    document.body.appendChild(tempElement);
    const textHeight = tempElement.offsetHeight;
    document.body.removeChild(tempElement);
    
    setHeight(textHeight);
  }, [text, maxWidth]);
  
  return height;
};

const InstagramNotes = () => {
  return (
    <div className="ig-notes w-full overflow-hidden">
      <div className="ig-notes__scroller flex gap-2 overflow-x-auto scrollbar-hide">
        {mockNotes.map((note, index) => (
          <NoteItem key={note.id} note={note} index={index} />
        ))}
      </div>
    </div>
  );
};

const NoteItem = ({ note, index }: { note: Note; index: number }) => {
  const textHeight = useTextHeight(note.message || '');
  const topOffset = textHeight > 0 ? -(textHeight + 35) : 0; // 35px gap between bubble and avatar
  console.log(note.message, textHeight, topOffset);
  
  return (
    <div className="ig-notes__item px-2 flex flex-col items-center flex-shrink-0 pt-20">
      {/* Avatar and note container */}
      <div className="ig-notes__avatar-wrap relative mb-2">
            <>
            {/* Profile picture */}
            <img
              src={note.avatar}
              alt={note.username}
              className="ig-notes__avatar w-16 h-16 rounded-full object-cover cursor-pointer hover:scale-105 transition-transform duration-200"
            />
            
            {/* Online indicator */}
            {note.isOnline && (
              <div className="ig-notes__online absolute bottom-1 right-1 w-4 h-4 bg-online rounded-full border-2 border-background"></div>
            )}
            
            {/* Note message bubble */}
            {note.message && (
              <div 
                className="ig-notes__bubble absolute left-1/2 transform -translate-x-1/2 bg-notes-bg border border-notes-border rounded-2xl px-4 py-2 max-w-[200px] shadow-soft"
                style={{ top: `${topOffset}px` }}
              >
                <p className="ig-notes__bubble-text text-xs text-foreground text-center font-medium leading-tight">
                  {note.message}
                </p>
                {/* Speech bubble arrow */}
                <div className="ig-notes__bubble-arrow absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-notes-bg"></div>
              </div>
            )}
          </>
      </div>
      
      {/* Username */}
      <p className="ig-notes__username text-xs text-foreground font-medium text-center max-w-[70px] truncate">
        {note.username}
      </p>
    </div>
  );
};

export default InstagramNotes;