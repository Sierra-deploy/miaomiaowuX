import { cn } from '@/lib/utils'

interface AnimatedXProps {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

export function AnimatedX({ size = 'md', className }: AnimatedXProps) {
  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-4xl sm:text-5xl md:text-6xl',
    xl: 'text-5xl sm:text-6xl md:text-7xl',
  }

  return (
    <>
      <span
        className={cn(
          'relative inline-block font-bold select-none',
          sizeClasses[size],
          className,
        )}
      >
        <span className="animated-x-text relative z-10">X</span>
        <span className="animated-x-glow absolute inset-0 z-0 blur-md opacity-60" aria-hidden>X</span>
        <span className="animated-x-particles absolute inset-0 z-20 pointer-events-none" aria-hidden />
      </span>
      <style>{`
        .animated-x-text {
          background: linear-gradient(
            135deg,
            #f97316 0%,
            #ef4444 15%,
            #f59e0b 30%,
            #f97316 45%,
            #ec4899 60%,
            #f59e0b 75%,
            #f97316 90%,
            #ef4444 100%
          );
          background-size: 300% 300%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: x-gradient-shift 3s ease-in-out infinite, x-shimmer 2s ease-in-out infinite;
        }

        .animated-x-glow {
          background: linear-gradient(
            135deg,
            #f97316,
            #ef4444,
            #f59e0b,
            #f97316
          );
          background-size: 300% 300%;
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          animation: x-gradient-shift 3s ease-in-out infinite, x-pulse-glow 2s ease-in-out infinite;
        }

        .animated-x-particles::before,
        .animated-x-particles::after {
          content: '✦';
          position: absolute;
          font-size: 0.3em;
          animation: x-sparkle 2.5s ease-in-out infinite;
        }

        .animated-x-particles::before {
          top: -0.2em;
          right: -0.1em;
          color: #f59e0b;
          animation-delay: 0s;
        }

        .animated-x-particles::after {
          bottom: -0.1em;
          left: -0.1em;
          color: #f97316;
          animation-delay: 1.2s;
        }

        @keyframes x-gradient-shift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }

        @keyframes x-shimmer {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.3); }
        }

        @keyframes x-pulse-glow {
          0%, 100% { opacity: 0.3; filter: blur(8px); }
          50% { opacity: 0.7; filter: blur(12px); }
        }

        @keyframes x-sparkle {
          0%, 100% { opacity: 0; transform: scale(0.5) rotate(0deg); }
          20% { opacity: 1; transform: scale(1) rotate(90deg); }
          40% { opacity: 0; transform: scale(0.5) rotate(180deg); }
        }
      `}</style>
    </>
  )
}
