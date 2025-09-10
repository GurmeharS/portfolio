import { Link, NavLink } from "react-router-dom";

const Nav = () => {
  return (
    <header className="nav fixed inset-x-0 bottom-0 z-50 bg-background/70 backdrop-blur supports-[backdrop-filter]:bg-background/50 border-t border-border">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <Link to="/" className="nav__brand text-sm font-semibold tracking-wide lowercase">
          gurmehar sandhu
        </Link>
        <nav className="nav__links flex items-center gap-6 text-sm text-muted-foreground">
          <NavLink to="/" end className={({isActive}) => isActive ? "text-foreground lowercase" : "hover:text-foreground lowercase"}>home</NavLink>
          <NavLink to="/experience" className={({isActive}) => isActive ? "text-foreground lowercase" : "hover:text-foreground lowercase"}>experience</NavLink>
          <NavLink to="/projects" className={({isActive}) => isActive ? "text-foreground lowercase" : "hover:text-foreground lowercase"}>projects</NavLink>
          <NavLink to="/contact" className={({isActive}) => isActive ? "text-foreground lowercase" : "hover:text-foreground lowercase"}>contact</NavLink>
        </nav>
      </div>
    </header>
  );
};

export default Nav;


