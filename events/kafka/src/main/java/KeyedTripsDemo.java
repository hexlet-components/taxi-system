import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;

public class KeyedTripsDemo {
    public static void main(String[] args) throws Exception {
        String broker = System.getenv().getOrDefault("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092");
        String topic = "lesson-keyed-trips-" + UUID.randomUUID();
        try (var admin = Admin.create(Map.of("bootstrap.servers", broker))) {
            // Две партиции позволяют независимо читать две части потока
            admin.createTopics(List.of(new NewTopic(topic, 2, (short) 1))).all().get();
        }

        var producerConfig = new Properties();
        producerConfig.put("bootstrap.servers", broker);
        producerConfig.put("key.serializer", StringSerializer.class.getName());
        producerConfig.put("value.serializer", StringSerializer.class.getName());
        try (var producer = new KafkaProducer<String, String>(producerConfig)) {
            for (String tripId : List.of("42", "43")) {
                var versions = tripId.equals("42") ? List.of(6, 7) : List.of(2, 3);
                for (int version : versions) {
                    String payload = "{\"version\":" + version + "}";
                    // Ключ передаётся отдельно от JSON и определяет партицию
                    var record = new ProducerRecord<>(topic, tripId, payload);
                    var saved = producer.send(record).get();
                    System.out.printf(
                            "saved key=%s partition=%d offset=%d%n",
                            tripId, saved.partition(), saved.offset());
                }
            }
        }

        var consumerConfig = new Properties();
        consumerConfig.put("bootstrap.servers", broker);
        consumerConfig.put("key.deserializer", StringDeserializer.class.getName());
        consumerConfig.put("value.deserializer", StringDeserializer.class.getName());
        consumerConfig.put("enable.auto.commit", "false");
        try (var consumer = new KafkaConsumer<String, String>(consumerConfig)) {
            var partitions = List.of(new TopicPartition(topic, 0), new TopicPartition(topic, 1));
            // Назначаем обе партиции вручную, чтобы наблюдать порядок одного читателя
            consumer.assign(partitions);
            consumer.seekToBeginning(partitions);
            int received = 0;
            long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();
            while (received < 4 && System.nanoTime() < deadline) {
                for (var record : consumer.poll(Duration.ofMillis(500))) {
                    System.out.printf(
                            "read key=%s partition=%d offset=%d value=%s%n",
                            record.key(), record.partition(), record.offset(), record.value());
                    received++;
                }
            }
            if (received != 4) {
                throw new IllegalStateException("Expected 4 records, received " + received);
            }
        }
    }
}
