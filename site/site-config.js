// Stillingar vefsins. Breyttu photoBase ef frummyndirnar eru ekki í photos/ í
// síðunni sjálfri heldur t.d. í Azure Blob Storage (endar á "/").
window.SITE_CONFIG = {
  photoBase: 'https://f003.backblazeb2.com/file/Holtavorduheidi3/',
  thumbBase: 'thumbs/',
  // Yfirlag lína/mastra úr korti ofan á 360° myndum (sleðar + útflutningur). Slökkt að sinni.
  overlay: false,
};
