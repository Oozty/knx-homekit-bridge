# KNX Bridge Pro v0.1.0

Windows üzerinde KNX/IP cihazlarını Apple HomeKit'e köprüleyen ilk kullanılabilir sürüm.

## Bu sürümün kapsamı

- KNX/IP gateway otomatik keşfi
- Apple HomeKit köprüsü
- Apple Ev uygulamasına PIN ile ekleme
- Aç/kapat aydınlatma ve anahtar
- Dimmer
- Perde/panjur konum kontrolü
- Sıcaklık sensörü
- Kapı/pencere kontak sensörü
- Node.js ve npm kurulumu gerektirmeyen Windows x64 EXE

## Önemli gereksinim

KNX cihazlarının işlevlerini belirlemek için ETS grup adresleri gerekir. Program gateway'i otomatik bulabilir; ancak hangi grup adresinin hangi lambaya veya perdeye ait olduğunu güvenilir biçimde tahmin edemez.

## İlk kurulum

1. ZIP dosyasını sabit bir klasöre çıkarın.
2. `KNX-Cihazlarini-Tara.bat` dosyasını çalıştırın.
3. Bulunan IP adresini `config.yml` içindeki `gatewayIp` alanına yazın.
4. ETS grup adreslerini `accessories` bölümüne girin.
5. `KNX-HomeKit-Baslat.bat` dosyasını çalıştırın.
6. Windows Güvenlik Duvarı sorarsa yalnızca **Özel ağlar** için izin verin.
7. iPhone'da **Ev > + > Aksesuar Ekle > Daha Fazla Seçenek** yolunu açın.
8. `KNX Bridge Pro` köprüsünü seçin ve `config.yml` içindeki PIN'i girin.

## config.yml cihaz türleri

### Işık

```yaml
- id: salon-tavan
  name: "Salon Tavan"
  type: light
  writeAddress: "1/0/1"
  statusAddress: "1/0/2"
```

### Dimmer

```yaml
- id: salon-spot
  name: "Salon Spot"
  type: dimmer
  switchWriteAddress: "1/1/1"
  switchStatusAddress: "1/1/2"
  brightnessWriteAddress: "1/1/3"
  brightnessStatusAddress: "1/1/4"
```

### Perde veya panjur

```yaml
- id: salon-perde
  name: "Salon Perde"
  type: blind
  positionWriteAddress: "2/0/1"
  positionStatusAddress: "2/0/2"
  invert: true
```

`invert: true`, KNX'teki yüzde yönü Apple Home ile ters olduğunda kullanılır.

## Güvenlik

- Modem veya router üzerinden UDP 3671 portunu internete açmayın.
- Köprü yalnızca yerel ağda kullanılmalıdır.
- KNX IP Secure bu ilk sürümde desteklenmez.
- HomeKit PIN'ini herkese açık paylaşmayın.

## Bilinen sınırlamalar

- ETS proje dosyasını otomatik içe aktarma henüz yoktur.
- KNX IP Secure henüz yoktur.
- Windows Service kurulumu henüz yoktur.
- RGB/RGBW, klima, termostat ve sahneler sonraki sürümlere bırakılmıştır.
