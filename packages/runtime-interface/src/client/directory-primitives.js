// Public change history: docs/PUBLIC-CHANGES.md
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

// Export changes of the official primitive library are resolved at this seam.
// Business components use semantic names and keep their existing size/style.
export const DirectoryButton = primitives.Button
export const DirectoryModal = primitives.Modal
export const DirectoryCheckIcon = primitives.IconCheckOutline16 ?? primitives.IconCheckOutlineRegular
export const DirectoryRightIcon = primitives.IconChevronRightOutline14 ?? primitives.IconChevronRightOutlineRegular
export const DirectoryUpIcon = primitives.IconChevronUpOutline14 ?? primitives.IconChevronUpOutlineRegular
export const DirectoryCloseIcon = primitives.IconCloseOutline16 ?? primitives.IconCloseOutlineRegular
export const DirectoryEditIcon = primitives.IconEditOutline16 ?? primitives.IconEditOutlineRegular
export const DirectoryFolderIcon = primitives.IconFolderClose16 ?? primitives.IconFolderCloseRegular
export const DirectoryOpenFolderIcon = primitives.IconFolderOpen16 ?? primitives.IconFolderOpenRegular
export const DirectoryPlusIcon = primitives.IconPlusOutline16 ?? primitives.IconPlusOutlineRegular
export const DirectoryHostIcon = primitives.IconGlobeOutline14 ?? primitives.IconGlobeOutlineRegular
