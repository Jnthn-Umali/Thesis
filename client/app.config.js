import appJson from './app.json';

export default ({ config }) => {
  const base = appJson.expo ?? {};

  const easProfile = process.env.EAS_BUILD_PROFILE ?? 'development';
  const isDevLike = easProfile === 'development';

  const name = isDevLike ? 'EYESEE Dev' : 'EYESEE';
  // Keep a single stable slug for the EAS project
  const slug = 'eyesee';
  const scheme = isDevLike ? 'eyesee-dev' : 'eyesee';
  const androidPackage = isDevLike
    ? 'com.rem2126.client.dev'
    : 'com.rem2126.eyesee';

  return {
    ...config,
    ...base,
    name,
    slug,
    scheme,
    icon: './assets/images/iconeyefy.png',
    android: {
      ...(base.android ?? {}),
      icon: './assets/images/iconeyefy.png',
      adaptiveIcon: {
        ...(base.android?.adaptiveIcon ?? {}),
        // Use the same icon asset as the foreground so dev and prod match visually
        foregroundImage: './assets/images/iconeyefy.png',
      },
      package: androidPackage,
    },
  };
};

