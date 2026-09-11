"use client";

import { useEffect, useState } from "react";

type GalleryPhoto = {
  id: string;
  url: string;
};

export default function TenderProfilePhotos({
  tenderName,
  fallbackInitial,
  heroPhotoUrl,
  galleryPhotos,
}: {
  tenderName: string;
  fallbackInitial: string;
  heroPhotoUrl: string | null;
  galleryPhotos: GalleryPhoto[];
}) {
  const [galleryOpen, setGalleryOpen] = useState(false);

  const previewPhotos = galleryPhotos.slice(0, 3);
  const remainingCount = Math.max(
    galleryPhotos.length - 3,
    0
  );

  useEffect(() => {
    if (!galleryOpen) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGalleryOpen(false);
      }
    };

    window.addEventListener("keydown", handleKey);

    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [galleryOpen]);

  return (
    <>
      <div
        className="tender-profile-photo-layout has-gallery"
      >
        <div className="tender-profile-photo-primary">
          {heroPhotoUrl ? (
            <img
              src={heroPhotoUrl}
              alt={tenderName}
              className="tender-profile-photo"
            />
          ) : (
            <div className="photo-fallback tender-profile-fallback">
              {fallbackInitial}
            </div>
          )}
        </div>

        <div className="tender-profile-photo-previews">
          {Array.from({ length: 3 }).map((_, index) => {
            const photo = previewPhotos[index];

            if (!photo) {
              return (
                <div
                  className="tender-profile-photo-preview tender-profile-photo-preview-empty"
                  key={`empty-${index}`}
                  aria-hidden="true"
                />
              );
            }

            const isLastVisible =
              index === previewPhotos.length - 1;

            return (
              <button
                type="button"
                className="tender-profile-photo-preview"
                key={photo.id}
                onClick={() => setGalleryOpen(true)}
                aria-label={`View ${tenderName} photo gallery`}
              >
                <img
                  src={photo.url}
                  alt={`${tenderName} gallery photo ${index + 1}`}
                />

                {isLastVisible && (
                  <span className="tender-gallery-plus">
                    {remainingCount > 0
                      ? `+${remainingCount}`
                      : "+"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {galleryOpen && (
        <div
          className="tender-gallery-modal-backdrop"
          role="presentation"
          onClick={() => setGalleryOpen(false)}
        >
          <div
            className="tender-gallery-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${tenderName} photo gallery`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tender-gallery-modal-heading">
              <div>
                <div className="eyebrow">
                  Tender Gallery
                </div>

                <h2>{tenderName}</h2>
              </div>

              <button
                type="button"
                className="tender-gallery-close"
                onClick={() => setGalleryOpen(false)}
                aria-label="Close gallery"
              >
                ×
              </button>
            </div>

            <div className="tender-gallery-modal-grid">
              {galleryPhotos.map((photo, index) => (
                <img
                  src={photo.url}
                  alt={`${tenderName} gallery photo ${
                    index + 1
                  }`}
                  key={photo.id}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
