import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'

export interface ThemedSelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface ThemedSelectProps {
  id?: string
  value: string
  options: ThemedSelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
}

const defaultTriggerStyle: React.CSSProperties = {
  color: '#ffffff',
  background: 'linear-gradient(135deg, rgba(5, 8, 7, 0.96) 0%, rgba(11, 33, 27, 0.96) 65%, rgba(24, 76, 61, 0.9) 100%)',
  border: '1px solid #40826D',
}

export default function ThemedSelect({
  id: idProp,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  disabled = false,
  className = '',
  style = {},
}: ThemedSelectProps) {
  const reactId = useId()
  const baseId = idProp ?? `themed-select-${reactId.replace(/:/g, '')}`
  const triggerId = `${baseId}-trigger`
  const menuId = `${baseId}-menu`

  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selectedIndex = options.findIndex((o) => o.value === value)

  const openMenu = () => {
    if (disabled || options.length === 0) return
    const startIndex = selectedIndex >= 0 ? selectedIndex : 0
    setActiveIndex(startIndex)
    setIsOpen(true)
  }

  const closeMenu = () => setIsOpen(false)

  const selectOption = (index: number) => {
    const opt = options[index]
    if (!opt || opt.disabled) return
    onChange(opt.value)
    closeMenu()
    triggerRef.current?.focus()
  }

  const moveActive = (delta: number) => {
    const len = options.length
    if (len === 0) return
    let next = activeIndex
    for (let i = 0; i < len; i++) {
      next = (next + delta + len) % len
      if (!options[next].disabled) break
    }
    setActiveIndex(next)
  }

  const positionMenu = () => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return

    const triggerRect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const spaceBelow = window.innerHeight - triggerRect.bottom
    const menuHeight = menuRect.height
    const viewportPadding = 8

    let top: number
    if (spaceBelow >= menuHeight + 4) {
      top = triggerRect.bottom + 4
    } else if (triggerRect.top >= menuHeight + 4) {
      top = triggerRect.top - menuHeight - 4
    } else {
      top = Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding)
    }

    let left = triggerRect.left
    const width = triggerRect.width
    if (left + width > window.innerWidth - viewportPadding) {
      left = Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
    }

    setMenuStyle({
      position: 'fixed',
      top,
      left,
      width,
      zIndex: 1500,
    })
  }

  useLayoutEffect(() => {
    if (!isOpen) return
    positionMenu()

    const handleResize = () => positionMenu()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return
      }
      closeMenu()
    }

    const handleScroll = () => closeMenu()

    document.addEventListener('mousedown', handleClick, true)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [isOpen])

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!isOpen) {
        openMenu()
      } else {
        moveActive(e.key === 'ArrowDown' ? 1 : -1)
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (isOpen) {
        selectOption(activeIndex)
      } else {
        openMenu()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (isOpen) {
        closeMenu()
        triggerRef.current?.focus()
      }
    } else if (e.key === 'Home') {
      e.preventDefault()
      if (isOpen) {
        const firstEnabled = options.findIndex((o) => !o.disabled)
        if (firstEnabled >= 0) setActiveIndex(firstEnabled)
      }
    } else if (e.key === 'End') {
      e.preventDefault()
      if (isOpen) {
        let lastEnabled = -1
        for (let i = options.length - 1; i >= 0; i--) {
          if (!options[i].disabled) {
            lastEnabled = i
            break
          }
        }
        if (lastEnabled >= 0) setActiveIndex(lastEnabled)
      }
    }
  }

  const selectedOption = options[selectedIndex]

  return (
    <div className="relative w-full">
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={menuId}
        aria-activedescendant={isOpen ? `${baseId}-option-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        className={[
          'w-full flex items-center justify-between px-3 py-2 rounded-md text-sm text-left focus:outline-none focus:ring-2 focus:ring-[#93E9BE] transition-colors',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          className,
        ].filter(Boolean).join(' ')}
        style={{ ...defaultTriggerStyle, ...style }}
      >
        <span className="truncate">{selectedOption?.label ?? placeholder}</span>
        <ChevronDown
          className={`w-4 h-4 ml-2 flex-shrink-0 text-[#93E9BE] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            role="listbox"
            aria-labelledby={triggerId}
            className="rounded-md overflow-y-auto"
            style={{
              ...menuStyle,
              background: '#020807',
              border: '1px solid #40826D',
              boxShadow: '0 10px 25px rgba(0, 0, 0, 0.5)',
              maxHeight: 'min(40vh, 320px)',
            }}
          >
            {options.map((opt, i) => {
              const isSelected = opt.value === value
              const isActive = i === activeIndex
              const optionId = `${baseId}-option-${i}`

              const classes = [
                'px-3 py-2 text-sm transition-colors outline-none',
                isSelected ? 'bg-[#93E9BE] text-[#020807]' : 'text-white',
                isActive && !isSelected ? 'bg-[#93E9BE] text-[#020807]' : '',
                opt.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-[#93E9BE] hover:text-[#020807]',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <div
                  key={opt.value}
                  id={optionId}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled}
                  tabIndex={-1}
                  onClick={() => !opt.disabled && selectOption(i)}
                  onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
                  className={classes}
                >
                  {opt.label}
                </div>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}
